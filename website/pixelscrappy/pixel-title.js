/* Pixel lettering for hero titles.
   <h1 class="pxtitle" data-px="PIXEL SCRAPPY">Pixel Scrappy</h1>
   Each word is drawn from a 5x7 bitmap font as SVG blocks: crisp at any size,
   no font file to load, and every letter can move on its own. The original
   text stays in the element for screen readers and search engines. */
(function () {
  var FONT = {
    A: ["01110","10001","10001","11111","10001","10001","10001"],
    B: ["11110","10001","10001","11110","10001","10001","11110"],
    C: ["01111","10000","10000","10000","10000","10000","01111"],
    D: ["11110","10001","10001","10001","10001","10001","11110"],
    E: ["11111","10000","10000","11110","10000","10000","11111"],
    F: ["11111","10000","10000","11110","10000","10000","10000"],
    G: ["01111","10000","10000","10011","10001","10001","01111"],
    H: ["10001","10001","10001","11111","10001","10001","10001"],
    I: ["11111","00100","00100","00100","00100","00100","11111"],
    J: ["00111","00010","00010","00010","00010","10010","01100"],
    K: ["10001","10010","10100","11000","10100","10010","10001"],
    L: ["10000","10000","10000","10000","10000","10000","11111"],
    M: ["10001","11011","10101","10101","10001","10001","10001"],
    N: ["10001","11001","10101","10011","10001","10001","10001"],
    O: ["01110","10001","10001","10001","10001","10001","01110"],
    P: ["11110","10001","10001","11110","10000","10000","10000"],
    Q: ["01110","10001","10001","10001","10101","10010","01101"],
    R: ["11110","10001","10001","11110","10100","10010","10001"],
    S: ["01111","10000","10000","01110","00001","00001","11110"],
    T: ["11111","00100","00100","00100","00100","00100","00100"],
    U: ["10001","10001","10001","10001","10001","10001","01110"],
    V: ["10001","10001","10001","10001","10001","01010","00100"],
    W: ["10001","10001","10001","10101","10101","11011","10001"],
    X: ["10001","10001","01010","00100","01010","10001","10001"],
    Y: ["10001","10001","01010","00100","00100","00100","00100"],
    Z: ["11111","00001","00010","00100","01000","10000","11111"],
    "$": ["00100","01111","10100","01110","00101","11110","00100"],
    "!": ["00100","00100","00100","00100","00100","00000","00100"]
  };
  var NS = "http://www.w3.org/2000/svg";

  function word(text, startIndex) {
    var cols = text.length * 6 - 1;
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "-0.5 -0.5 " + (cols + 1.5) + " 8.5");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("shape-rendering", "crispEdges");
    svg.style.setProperty("--cols", cols + 1.5);
    for (var i = 0; i < text.length; i++) {
      var glyph = FONT[text[i]];
      if (!glyph) continue;
      var g = document.createElementNS(NS, "g");
      g.setAttribute("class", "px-ch");
      g.style.setProperty("--i", startIndex + i);
      var shadow = document.createElementNS(NS, "g"), face = document.createElementNS(NS, "g");
      shadow.setAttribute("class", "px-shadow"); face.setAttribute("class", "px-face");
      for (var y = 0; y < 7; y++) for (var x = 0; x < 5; x++) {
        if (glyph[y][x] !== "1") continue;
        [[shadow, 0.5], [face, 0]].forEach(function (p) {
          var r = document.createElementNS(NS, "rect");
          r.setAttribute("x", i * 6 + x + p[1]); r.setAttribute("y", y + p[1]);
          r.setAttribute("width", 1); r.setAttribute("height", 1);
          p[0].appendChild(r);
        });
        if (y === 0) {                     // a lighter top edge, like a lit pixel sprite
          var hi = document.createElementNS(NS, "rect");
          hi.setAttribute("x", i * 6 + x); hi.setAttribute("y", 0);
          hi.setAttribute("width", 1); hi.setAttribute("height", 0.34);
          hi.setAttribute("class", "px-hi");
          face.appendChild(hi);
        }
      }
      g.appendChild(shadow); g.appendChild(face);
      svg.appendChild(g);
    }
    return svg;
  }

  function render(el) {
    var text = (el.getAttribute("data-px") || el.textContent).toUpperCase().trim();
    var label = el.textContent.trim() || text;
    var box = document.createElement("span");
    box.className = "px-words";
    var n = 0;
    text.split(/\s+/).forEach(function (w) {
      box.appendChild(word(w, n));
      n += w.length;
    });
    var sr = document.createElement("span");
    sr.className = "px-sr"; sr.textContent = label;
    el.textContent = "";
    el.appendChild(box); el.appendChild(sr);
    el.classList.add("px-ready");
  }

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll(".pxtitle"), render);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
