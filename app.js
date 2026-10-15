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

function showSolution() {
  var q = BANK[current.idx];
  current.revealed = true;
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
  if (!current.revealed && current.attempts >= 2) showSolution();
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