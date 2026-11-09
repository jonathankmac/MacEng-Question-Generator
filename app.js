/* ============================================================
   MacEng Practice — app.js
   Section 1: random background (one image via manifest).
   Section 2: course selection + question/answer-check loop.
   Questions are served from content/*.json banks; answers are
   numeric with a tolerance + unit, so checking is arithmetic.
   ============================================================ */

/* ---------------- Section 1: random background ---------------- */

(function () {
  var PICKED = false; // one pick per page load; persists across all view changes

  function choose(list) {
    return list[Math.floor(Math.random() * list.length)];
  }

  function fallback() {
    document.documentElement.classList.add("no-photo");
  }

  function apply(entry) {
    PICKED = true;
    // Preload the single image, then fade it in when ready —
    // avoids painting a half-downloaded background. If it never
    // arrives, fall back to the soft grey background.
    var img = new Image();
    img.onload = function () {
      var bg = document.getElementById("bg");
      var credit = document.getElementById("bg-credit");
      var text = document.getElementById("bg-credit-text");
      if (!bg) return;
      bg.style.backgroundImage = "url('" + entry.file + "')";
      bg.style.opacity = "1";
      if (credit && text) {
        var who = entry.photographer ? "Photo: " + entry.photographer : "Photo: unknown";
        text.textContent = who + " · " + entry.location;
        credit.hidden = false;
      }
    };
    img.onerror = fallback;
    img.src = entry.file;
  }

  fetch("backgrounds.json")
    .then(function (r) { return r.json(); })
    .then(function (list) {
      if (!PICKED && list && list.length) apply(choose(list));
      else fallback();
    })
    .catch(fallback); /* file:// or offline: soft grey background */
})();

/* ---------------- Section 2: content loading ---------------- */

var INDEX = null;   // content/index.json
var BANK = null;    // current course's question array

function loadJSON(url) {
  // cache: "no-cache" revalidates with the server every time, so edited
  // question banks show up on plain reloads during development.
  return fetch(url, { cache: "no-cache" }).then(function (r) {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  });
}

function loadCourse(courseId) {
  var course = INDEX.courses.filter(function (c) { return c.id === courseId; })[0];
  return loadJSON(course.bank);
}

/* ---------------- Section 3: KaTeX ---------------- */

function typeset(el) {
  if (window.renderMathInElement) {
    renderMathInElement(el, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false }
      ],
      throwOnError: false
    });
  }
}

/* ---------------- Section 4: views ---------------- */

var showView = (function () {
  var select = document.querySelector('[data-view="select"]');
  var question = document.querySelector('[data-view="question"]');
  var btnBack = document.getElementById("btn-back");
  return function (name) {
    select.hidden = name !== "select";
    question.hidden = name !== "question";
    btnBack.hidden = name !== "question";
  };
})();

/* ---------------- Section 5: answer parsing + checking ----------------

   One input field carries the number and the unit together ("10.1 m").
   Parsing is deliberately forgiving on format, strict on comparison:
   superscripts and stray spacing are normalized, then the unit must
   match the expected one exactly. */

function normalizeUnit(u) {
  return u.replace(/\s+/g, "")
    .replace(/²/g, "^2").replace(/³/g, "^3")
    .replace(/\*/g, "·");
}

function parseAnswer(text) {
  var t = text.trim().replace(/\s+/g, " ");
  var NUM = "[+-]?(\\d+(\\.\\d*)?|\\.\\d+)([eE][+-]?\\d+)?";
  // number + unit (unit must start with a non-digit AND non-dot:
  // "10.1 m", "10.1m" — this also stops "0.20" splitting into 0 | ".20")
  var m = t.match(new RegExp("^(" + NUM + ")\\s*([^\\d\\s.].*)$"));
  if (m) return { value: parseFloat(m[1]), unit: normalizeUnit(m[5]) };
  // bare number ("15", "0.20") -> valid value, missing unit
  var n = t.match(new RegExp("^(" + NUM + ")$"));
  if (n) return { value: parseFloat(n[1]), unit: "" };
  return { value: NaN, unit: "" };
}

/* Correct  = |user - value| <= max(value * tolerance, 1e-9) AND unit matches.
   Wrong    = retry in place, no answer given (hints/reveal come later).
   Numerics near zero use the absolute floor. */

function checkNumeric(userValue, answer) {
  var v = parseFloat(userValue);
  if (isNaN(v)) return false;
  var tol = Math.max(answer.value * answer.tolerance, 1e-9);
  return Math.abs(v - answer.value) <= tol;
}

/* ---------------- Section 5b: answer history (Step 0) ----------------

   Event log: one row per check-button press, plus one per reveal.
   Stored under a single localStorage key as a JSON array. Raw events
   only — stats (accuracy, weak topics) are derived later, and cloud
   sync (Step 2) will duplicate writes, not change this contract. */

var ANSWER_LOG_KEY = "answer_log";

function getLocalEvents() {
  try {
    return JSON.parse(localStorage.getItem(ANSWER_LOG_KEY)) || [];
  } catch (e) { return []; }
}

function recordAnswer(event) {
  var log = getLocalEvents();
  event.ts = Date.now();
  log.push(event);
  try {
    localStorage.setItem(ANSWER_LOG_KEY, JSON.stringify(log));
  } catch (e) { /* private mode / quota full: lose one record, never break the loop */ }

  // Write-through: when signed in, the same event also goes to the cloud.
  // Fire-and-forget — a network failure must never break the question
  // loop, and the local copy is always there. RLS stamps ownership:
  // with check (auth.uid() = user_id) makes a forged user_id impossible.
  if (session && window.sb) {
    window.sb.from("answer_log").insert({
      user_id: session.user.id,
      variant_id: event.variant_id,
      submitted_value: event.submitted_value,
      unit: event.unit,
      correct: event.correct,
      revealed: event.revealed
    }).then(function (res) {
      if (res.error) {
        // Keep the app working; surface for debugging in the console.
        console.warn("Cloud save failed:", res.error.message);
      }
    });
  }
}

/* ---------------- Section 5c: tag stats + question serving ----------------

   Three layers, one pass each:
   1. getQuestionStates(events) — fold raw events into per-question
      state: { tags, completed, lastTs }. "Completed" = latest visit
      was first-attempt correct; a visit ends at a correct/revealed event.
   2. getTopicStats(events) — aggregate states into weighted tag load
      (backlog metric: completed questions contribute nothing).
   3. pickNextQuestion(bank, events, avoidIdx) — the serving rule:
      probability gate u/(u+f) between exploration (unvisited) and
      repair (failed), weakest tag first, questions scored by the
      weighted sum of their tags' loads, top-3 randomness. */

function getQuestionStates(events) {
  var states = {};
  if (!events || events.length === 0) return states;
  events.slice().sort(function (a, b) { return a.ts - b.ts; }).forEach(function (e) {
    if (!e.tags) return; // pre-weights schema event: unusable, skip
    var s = states[e.variant_id];
    if (!s) s = states[e.variant_id] = { tags: e.tags, completed: false, lastTs: 0, inVisit: false, firstOk: null };
    s.lastTs = e.ts;
    if (e.correct || e.revealed) {
      // visit resolution: was this visit's FIRST attempt correct?
      var firstOk = s.inVisit ? s.firstOk : (e.correct === true);
      s.completed = firstOk;
      s.inVisit = false;
      s.firstOk = null;
    } else {
      // a check attempt: opens the visit if none open (a newly opened
      // visit is unresolved, so any prior "completed" status is void),
      // and records first-attempt
      if (!s.inVisit) { s.inVisit = true; s.firstOk = (e.correct === true); s.completed = false; }
    }
  });
  // strip fold bookkeeping from the public shape
  Object.keys(states).forEach(function (vid) {
    delete states[vid].inVisit;
    delete states[vid].firstOk;
  });
  return states;
}

function getTopicStats(events) {
  var states = getQuestionStates(events);
  var load = {};
  var anyCounted = false;
  Object.keys(states).forEach(function (vid) {
    var s = states[vid];
    anyCounted = true;
    if (s.completed) return; // weight irrelevant for completed questions
    Object.keys(s.tags).forEach(function (t) {
      load[t] = (load[t] || 0) + s.tags[t];
    });
  });
  return anyCounted ? load : null;
}

function pickNextQuestion(bank, events, avoidIdx) {
  if (events === undefined) events = getLocalEvents();
  var states = getQuestionStates(events);

  // pools: unvisited (never served) and failed (visited, not completed)
  var unvisited = [];
  var failed = [];
  bank.forEach(function (q, idx) {
    var s = states[q.id];
    if (!s) unvisited.push(idx);
    else if (!s.completed) failed.push({ idx: idx, s: s });
  });

  // bank exhausted: nothing new, nothing failed -> oldest-served
  if (unvisited.length === 0 && failed.length === 0) {
    var oldestIdx = -1;
    bank.forEach(function (q, idx) {
      var s = states[q.id];
      if (s && (oldestIdx === -1 || s.lastTs < states[bank[oldestIdx].id].lastTs)) oldestIdx = idx;
    });
    return oldestIdx;
  }

  // exploration branch (probability gate u/(u+f); forced if no failed pool)
  if (failed.length === 0 ||
      (unvisited.length > 0 &&
       Math.random() < unvisited.length / (unvisited.length + failed.length))) {
    return unvisited[Math.floor(Math.random() * unvisited.length)];
  }

  // repair branch: weakest tag — random only among NEAR-TIES (within
  // 80% of the top load), so a barely-loaded tag can't hijack the pick
  var load = {};
  failed.forEach(function (f) {
    Object.keys(f.s.tags).forEach(function (t) {
      load[t] = (load[t] || 0) + f.s.tags[t];
    });
  });
  var ranked = Object.keys(load).sort(function (a, b) { return load[b] - load[a]; });
  var band = load[ranked[0]] * 0.8;
  var nearTies = ranked.filter(function (t) { return load[t] >= band; }).slice(0, 3);

  // candidate pools must exclude the question just served (avoidIdx);
  // if a near-tie tag's pool is only that question, try the other tags
  var order = nearTies.slice();
  for (var i = order.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
  }
  var scored = null;
  for (var k = 0; k < order.length; k++) {
    var tag = order[k];
    var pool = failed.filter(function (f) {
      return (f.s.tags[tag] || 0) > 0 && f.idx !== avoidIdx;
    });
    if (pool.length === 0) continue;
    scored = pool.map(function (f) {
      var score = 0;
      Object.keys(f.s.tags).forEach(function (t) {
        score += f.s.tags[t] * (load[t] || 0);
      });
      return { idx: f.idx, score: score };
    });
    break;
  }

  // every near-tie pool was only the avoided question: fall back to a
  // fresh unvisited question; if none exist, repeating is unavoidable
  if (!scored && unvisited.length > 0) {
    return unvisited[Math.floor(Math.random() * unvisited.length)];
  }
  if (!scored) {
    var tag = nearTies[0];
    scored = failed.filter(function (f) { return (f.s.tags[tag] || 0) > 0; })
      .map(function (f) { return { idx: f.idx, score: 0 }; });
  }

  scored.sort(function (a, b) { return b.score - a.score; });
  var topCandidates = scored.slice(0, Math.min(3, scored.length));
  return topCandidates[Math.floor(Math.random() * topCandidates.length)].idx;
}/* ---------------- Section 6: the loop ----------------

   question → Check → correct: solution shown, button = Next question
                     wrong:   feedback, retry (solution link after 2 tries) */

var current = null; // { idx, attempts, revealed }

var qText = document.getElementById("q-text");
var aInput = document.getElementById("a-input");
var aBox = document.getElementById("a-box");
var feedback = document.getElementById("feedback");
var btnMain = document.getElementById("btn-main");

function loadQuestion(idx) {
  current = { idx: idx, attempts: 0, revealed: false };
  var q = BANK[idx];
  qText.textContent = q.prompt;
  typeset(qText);
  aInput.value = "";
  aInput.disabled = false;
  aBox.hidden = true;
  aBox.innerHTML = "";
  feedback.hidden = true;
  btnMain.textContent = "Check answer";
  showView("question");
}

function showSolution(gaveUp) {
  var q = BANK[current.idx];
  current.revealed = true;
  // Log the "gave up" event only when the student revealed without
  // solving — the success path must not pollute the log.
  if (gaveUp) {
    recordAnswer({
      variant_id: q.id,
      submitted_value: null,
      unit: null,
      correct: false,
      revealed: true,
      tags: q.tags
    });
  }
  // Simple-question format: no authored solutions. The reveal states
  // the correct answer — for plug-and-chug problems that is the
  // diagnostic a student needs to find their own slip.
  var unit = q.answer.unit;
  aBox.textContent = "The correct answer is " + q.answer.value + (unit ? " " + unit : "") + ".";
  aBox.hidden = false;
  aInput.disabled = true;
  btnMain.textContent = "Next question";
}

function onMainButton() {
  if (!current) return;
  if (current.revealed) { // Next question
    loadQuestion(pickNextQuestion(BANK, undefined, current.idx));
    return;
  }
  // Check answer: parse "number + unit" from the one field, then grade
  var q = BANK[current.idx];
  var parsed = parseAnswer(aInput.value);
  var ok;
  if (isNaN(parsed.value)) {
    ok = false;
    feedback.textContent = "Enter a number with its unit (e.g. 10.1 m).";
  } else if (!parsed.unit && q.answer.unit) {
    // only dimensionless questions accept a bare number
    ok = false;
    feedback.textContent = "Include a unit (e.g. 10.1 m).";
  } else {
    var numOk = checkNumeric(parsed.value, q.answer);
    var unitOk = parsed.unit === normalizeUnit(q.answer.unit);
    ok = numOk && unitOk;
    if (ok) {
      feedback.textContent = "Correct.";
      feedback.className = "feedback good";
      feedback.hidden = false;
      aInput.disabled = true;
      showSolution(); // learning: always show the worked solution, even on success
      recordAnswer({
        variant_id: q.id,
        submitted_value: parsed.value,
        unit: parsed.unit,
        correct: true,
        revealed: false,
        tags: q.tags
      });
      return;
    }
    feedback.textContent = numOk
      ? "Not quite. Check your units."
      : "Not quite. Check your work and try again.";
  }
  feedback.className = "feedback bad";
  feedback.hidden = false;
  current.attempts++;
  recordAnswer({
    variant_id: q.id,
    submitted_value: isNaN(parsed.value) ? null : parsed.value,
    unit: parsed.unit || null,
    correct: false,
    revealed: false,
    tags: q.tags
  });
  if (current.attempts >= 2) btnMain.textContent = "Reveal solution";
}

/* "Reveal solution" after 2 failed tries swaps the button's role */
btnMain.addEventListener("click", function () {
  if (!current) return;
  if (!current.revealed && current.attempts >= 2) showSolution(true);
  else onMainButton();
});

aInput.addEventListener("keydown", function (e) {
  if (e.key === "Enter") btnMain.click();
});

/* ---------------- Section 7: selection + boot ---------------- */

function renderBookmarks() {
  var row = document.getElementById("course-bookmarks");
  row.innerHTML = "";
  INDEX.courses.forEach(function (c) {
    var parts = c.label.split("•");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bookmark";
    btn.dataset.course = c.id;
    btn.innerHTML =
      '<span class="bookmark-label">' + parts[0].trim() +
      ' <span class="dot">•</span> ' + parts[1].trim() + "</span>";
    btn.addEventListener("click", function () {
      loadCourse(c.id).then(function (bank) {
        BANK = bank;
        loadQuestion(pickNextQuestion(bank, undefined, current ? current.idx : undefined));
      });
    });
    row.appendChild(btn);
  });
}

document.getElementById("btn-back").addEventListener("click", function () {
  showView("select");
});

/* ---------------- Section 8: accounts (Step 1) ----------------

   Supabase magic-link auth. The session (null or a user object) is
   the single source of truth; one render function derives the whole
   auth slot's UI from it. Anonymous practice is never gated. */

var SUPABASE_URL = "https://ixmodvcdksdlzgulksar.supabase.co";
var SUPABASE_KEY = "sb_publishable_MElxhK9152H_Ly1SvU97vg_zbZP-Jdw";

var authArea = document.getElementById("auth-area");
var session = null;  // null = anonymous; object = signed in
var authEmail = "";  // phase state of the OTP form (email awaiting its code)

function renderAuth() {
  if (session) {
    authArea.innerHTML =
      '<span class="auth-chip">Signed in as ' + session.user.email + '</span>' +
      '<button type="button" class="auth-link" id="btn-signout">Sign out</button>';
    document.getElementById("btn-signout").addEventListener("click", function () {
      window.sb.auth.signOut();
    });
  } else {
    authArea.innerHTML =
      '<button type="button" class="auth-link" id="btn-signin">Sign in to save progress</button>' +
      '<form class="auth-form" id="auth-form" hidden>' +
      '<input id="auth-email" type="email" placeholder="you@example.com" autocomplete="email">' +
      '<input id="auth-code" class="auth-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" hidden>' +
      '<button type="submit" class="btn-mini" id="auth-submit">Send code</button>' +
      "</form>" +
      '<p class="auth-msg" id="auth-msg" hidden></p>';
    document.getElementById("btn-signin").addEventListener("click", function () {
      document.getElementById("auth-form").hidden = false;
      document.getElementById("auth-email").focus();
    });
    document.getElementById("auth-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var msg = document.getElementById("auth-msg");
      var submitBtn = document.getElementById("auth-submit");
      if (submitBtn.disabled) return; // ignore double submits while a request is in flight
      msg.hidden = false;
      if (!authEmail) { // phase 1: request a code
        var email = document.getElementById("auth-email").value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          msg.textContent = "Please enter a valid email address.";
          return;
        }
        msg.textContent = "Sending…";
        submitBtn.disabled = true;
        window.sb.auth.signInWithOtp({ email: email }).then(function (result) {
          submitBtn.disabled = false;
          if (result.error) {
            msg.textContent = "Couldn't send the code: " + result.error.message;
            return;
          }
          authEmail = email;
          document.getElementById("auth-email").disabled = true;
          document.getElementById("auth-code").hidden = false;
          document.getElementById("auth-code").focus();
          submitBtn.textContent = "Verify";
          msg.textContent = "Check your email. A 6-digit code is on its way.";
        });
      } else { // phase 2: verify the code
        var code = document.getElementById("auth-code").value.replace(/\s+/g, "");
        msg.textContent = "Verifying…";
        submitBtn.disabled = true;
        window.sb.auth.verifyOtp({ email: authEmail, token: code, type: "email" }).then(function (result) {
          submitBtn.disabled = false;
          // success: onAuthStateChange fires and renderAuth rebuilds the signed-in UI
          if (result.error) {
            msg.textContent = "That code didn't match. Check the newest email.";
          }
        });
      }
    });
  }
}

function setSession(newSession) {
  var hadSession = !!session;
  session = newSession;
  if (session && !hadSession) pushLocalOnce(); // signed in just now: upload anonymous-era rows
  renderAuth();
}

// Init only if the SDK loaded (offline/file:// must not break the site).
if (window.supabase && window.supabase.createClient) {
  window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  window.sb.auth.getSession().then(function (res) {
    setSession(res.data.session); // restore an existing sign-in on reload
  });
  window.sb.auth.onAuthStateChange(function (_event, newSession) {
    setSession(newSession); // fires on sign-in via email link, sign-out, refresh
  });
}
// Init only if the SDK loaded (offline/file:// must not break the site).
if (window.supabase && window.supabase.createClient) {
  window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  window.sb.auth.getSession().then(function (res) {
    setSession(res.data.session); // restore an existing sign-in on reload
  });
  window.sb.auth.onAuthStateChange(function (_event, newSession) {
    setSession(newSession); // fires on sign-in via email link, sign-out, refresh
  });
}
// If the SDK never loaded, auth-area stays empty and practice works as always.

/* ---------------- Section 9: pushLocalOnce (Step 3a) ----------------

   One-way transport, not conflict resolution: the log is append-only,
   so the only question is "which local rows has the cloud never seen?"
   Merge rule: cloud wins; local pushes only what's missing. Runs once
   per sign-in, fire-and-forget. */

function pushLocalOnce() {
  var local = getLocalEvents();
  if (local.length === 0) return;

  window.sb.from("answer_log")
    .select("variant_id, submitted_value, correct, revealed, created_at")
    .then(function (res) {
      if (res.error) { console.warn("Push skipped (read failed):", res.error.message); return; }
      // What the cloud already has, as comparable signatures. Local ts
      // (ms) vs cloud created_at: match within ±2 seconds (the DB stamps
      // created_at just after our client-side ts), same variant required.
      var cloudByVariant = {};
      res.data.forEach(function (row) {
        var sec = Math.round(new Date(row.created_at).getTime() / 1000);
        (cloudByVariant[row.variant_id] = cloudByVariant[row.variant_id] || []).push(sec);
      });
      var missing = local.filter(function (e) {
        var secs = cloudByVariant[e.variant_id] || [];
        var ls = Math.floor(e.ts / 1000);
        return !secs.some(function (cs) { return Math.abs(cs - ls) <= 2; });
      });
      if (missing.length === 0) return;

      var rows = missing.map(function (e) {
        return {
          user_id: session.user.id,
          variant_id: e.variant_id,
          submitted_value: e.submitted_value,
          unit: e.unit,
          correct: e.correct,
          revealed: e.revealed,
          created_at: new Date(e.ts).toISOString() // preserve WHEN it happened
        };
      });
      window.sb.from("answer_log").insert(rows).then(function (res2) {
        if (res2.error) console.warn("Push failed:", res2.error.message);
        // no local cleanup: the log stays as this device's cache
      });
    });
}

loadJSON("content/index.json")
  .then(function (index) {
    INDEX = index;
    renderBookmarks();
    showView("select");
  })
  .catch(function () {
    // Content unavailable (file:// or offline): show nothing selectable.
    document.getElementById("course-bookmarks").innerHTML =
      '<p class="footnote">Question banks could not be loaded.</p>';
  });