/* ============================================================
   MacEng Practice — app.js
   v1 scope right now: background + course selection only.
   The question → solution cycle is torn out; it will be rebuilt
   on top of generate.py's content banks later.
   ============================================================ */

/* ---------------- Section 1: random background ----------------

   Performance contract: backgrounds.json is a tiny manifest of
   filenames + credits (generated from the Backgrounds/ folder).
   The page downloads the manifest (~5 KB) and exactly ONE image.
   Randomness happens over metadata, so loading one photo never
   means loading fifty. */

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

/* ---------------- Section 2: course selection + sample loop ----------------
   Sample question banks live here for now; generate.py will replace them
   with content/<course>/*.json. One course = one bank, cycled in order. */

var BANKS = {
  "1ZA3": [
    {
      q: "Compute $AB$ where $$A = \\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}, \\qquad B = \\begin{pmatrix} 0 & 1 \\\\ 1 & 0 \\end{pmatrix}.$$",
      a: "$$AB = \\begin{pmatrix} 2 & 1 \\\\ 4 & 3 \\end{pmatrix}$$ Multiply each row of $A$ into each column of $B$; since $BA = \\begin{pmatrix} 3 & 4 \\\\ 1 & 2 \\end{pmatrix} \\neq AB$, matrix multiplication is not commutative."
    },
    {
      q: "Compute $AB$ where $$A = \\begin{pmatrix} 2 & 0 \\\\ 1 & 3 \\end{pmatrix}, \\qquad B = \\begin{pmatrix} 1 & 1 \\\\ 0 & 2 \\end{pmatrix}.$$",
      a: "$$AB = \\begin{pmatrix} 2 & 2 \\\\ 1 & 7 \\end{pmatrix}$$ Row 1: $(2{\\cdot}1{+}0{\\cdot}0,\\ 2{\\cdot}1{+}0{\\cdot}2)$. Row 2: $(1{\\cdot}1{+}3{\\cdot}0,\\ 1{\\cdot}1{+}3{\\cdot}2)$."
    }
  ],
  "1ZC3": [
    {
      q: "Differentiate $f(x) = x^2 \\sin x$.",
      a: "$$f'(x) = 2x\\sin x + x^2\\cos x$$ By the product rule: $(x^2)'\\sin x + x^2(\\sin x)'$."
    },
    {
      q: "Differentiate $f(x) = e^{3x} \\cos x$.",
      a: "$$f'(x) = 3e^{3x}\\cos x - e^{3x}\\sin x$$ Product rule with $(e^{3x})' = 3e^{3x}$ and $(\\cos x)' = -\\sin x$."
    }
  ]
};

var showView = (function () {
  var select = document.querySelector('[data-view="select"]');
  var question = document.querySelector('[data-view="question"]');
  var btnBack = document.getElementById("btn-back");
  return function (name) {
    select.hidden = name !== "select";
    question.hidden = name !== "question";
    btnBack.hidden = name !== "question"; // Back lives in the header, question view only
  };
})();

/* KaTeX typesetting */
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

/* Question state: which course, which question in its bank */
var current = { course: null, idx: 0, revealed: false };

var btnMain = document.getElementById("btn-main");
var aBox = document.getElementById("a-box");

function loadQuestion(course, idx) {
  current = { course: course, idx: idx, revealed: false };
  var qt = document.getElementById("q-text");
  qt.textContent = BANKS[course][idx].q;
  typeset(qt);
  aBox.hidden = true;
  aBox.innerHTML = "";
  btnMain.textContent = "Show answer";
  showView("question");
}

btnMain.addEventListener("click", function () {
  if (!current.course) return;
  if (!current.revealed) {
    aBox.innerHTML = BANKS[current.course][current.idx].a;
    typeset(aBox);
    aBox.hidden = false;
    btnMain.textContent = "Next question";
    current.revealed = true;
  } else {
    var bank = BANKS[current.course];
    loadQuestion(current.course, (current.idx + 1) % bank.length);
  }
});

/* Bookmarks start the loop */
(function () {
  var bookmarks = document.querySelectorAll(".bookmark");
  bookmarks.forEach(function (btn) {
    btn.addEventListener("click", function () {
      bookmarks.forEach(function (b) {
        b.classList.toggle("is-active", b === btn);
        b.setAttribute("aria-pressed", b === btn ? "true" : "false");
      });
      loadQuestion(btn.dataset.course, 0);
    });
  });
})();

/* Back: return to course selection */
document.getElementById("btn-back").addEventListener("click", function () {
  showView("select");
});