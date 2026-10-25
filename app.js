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

/* ---------------- Section 5: answer checking ----------------

   Correct  = |user - value| <= max(value * tolerance, 1e-9) AND unit matches.
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

function recordAnswer(event) {
  var log;
  try {
    log = JSON.parse(localStorage.getItem(ANSWER_LOG_KEY)) || [];
  } catch (e) { log = []; }
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

function getTopicStats() {
  // Deliberately unimplemented (Step 0 scope): derivation of per-tag
  // accuracy arrives with the stats UI. Contract: returns null for now.
  return null;
}

/* ---------------- Section 6: the loop ----------------

   question → Check → correct: solution shown, button = Next question
                     wrong:   feedback, retry (solution link after 2 tries) */

var current = null; // { idx, attempts, revealed }

var qText = document.getElementById("q-text");
var aInput = document.getElementById("a-input");
var aUnit = document.getElementById("a-unit");
var aBox = document.getElementById("a-box");
var feedback = document.getElementById("feedback");
var btnMain = document.getElementById("btn-main");

function loadQuestion(idx) {
  current = { idx: idx, attempts: 0, revealed: false };
  var q = BANK[idx];
  qText.textContent = q.prompt;
  typeset(qText);
  // unit dropdown: one global mechanics unit list from the manifest,
  // starting with an unselected "Select unit" placeholder so the
  // student makes an explicit choice
  aUnit.innerHTML =
    '<option value="" disabled selected>Select unit</option>' +
    INDEX.units.map(function (u) {
      return '<option value="' + u + '">' + u + "</option>";
    }).join("");
  aInput.value = "";
  aInput.disabled = false;
  aUnit.disabled = false;
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
      revealed: true
    });
  }
  // No solution field in the bank yet — reveal states the correct
  // answer so a stuck student can at least unblock themselves.
  aBox.textContent = "The correct answer is " + q.answer.value + " " + q.answer.unit + ".";
  typeset(aBox);
  aBox.hidden = false;
  aInput.disabled = true;
  aUnit.disabled = true;
  btnMain.textContent = "Next question";
}

function onMainButton() {
  if (!current) return;
  if (current.revealed) { // Next question
    var next = Math.floor(Math.random() * BANK.length);
    if (BANK.length > 1) {
      while (next === current.idx) next = Math.floor(Math.random() * BANK.length);
    }
    loadQuestion(next);
    return;
  }
  // Check answer: unit must be actively chosen, then value+unit must match
  if (aUnit.value === "") {
    feedback.textContent = "Select a unit first.";
    feedback.className = "feedback bad";
    feedback.hidden = false;
    return;
  }
  var q = BANK[current.idx];
  var ok = checkNumeric(aInput.value, q.answer) &&
           aUnit.value === q.answer.unit;
  current.attempts++;
  recordAnswer({
    variant_id: q.id,
    submitted_value: parseFloat(aInput.value),
    unit: aUnit.value,
    correct: ok,
    revealed: false
  });
  if (ok) {
    feedback.textContent = "Correct.";
    feedback.className = "feedback good";
    feedback.hidden = false;
    aInput.disabled = true;
    aUnit.disabled = true;
    showSolution(); // learning: always show the worked solution, even on success
  } else {
    feedback.textContent = current.attempts >= 2
      ? "Still not quite. Check your units and rounding — or take a look below."
      : "Not quite. Check your work and try again.";
    feedback.className = "feedback bad";
    feedback.hidden = false;
    if (current.attempts >= 2) btnMain.textContent = "Reveal solution";
  }
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
        loadQuestion(Math.floor(Math.random() * bank.length));
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
var session = null; // null = anonymous; object = signed in

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
      '<button type="submit" class="btn-mini">Send sign-in link</button>' +
      "</form>" +
      '<p class="auth-msg" id="auth-msg" hidden></p>';
    document.getElementById("btn-signin").addEventListener("click", function () {
      document.getElementById("auth-form").hidden = false;
      document.getElementById("auth-email").focus();
    });
    document.getElementById("auth-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var email = document.getElementById("auth-email").value.trim();
      var msg = document.getElementById("auth-msg");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        msg.textContent = "Please enter a valid email address.";
        msg.hidden = false;
        return;
      }
      msg.textContent = "Sending…";
      msg.hidden = false;
      window.sb.auth.signInWithOtp({
        email: email,
        options: { emailRedirectTo: location.origin + location.pathname }
      }).then(function (result) {
        if (result.error) {
          msg.textContent = "Couldn't send the link: " + result.error.message;
        } else {
          document.getElementById("auth-form").hidden = true;
          msg.textContent = "Check your email — the sign-in link is on its way.";
        }
      });
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
  var local = [];
  try { local = JSON.parse(localStorage.getItem(ANSWER_LOG_KEY)) || []; }
  catch (e) { local = []; }
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