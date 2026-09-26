(function () {
  "use strict";

  var root = document.documentElement;
  var reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ─── Theme toggle (circular reveal, like the extension) ──────────── */
  var toggle = document.querySelector("[data-theme-toggle]");
  if (toggle) {
    toggle.addEventListener("click", function (e) {
      var next = root.getAttribute("data-scheme") === "dark" ? "light" : "dark";
      var apply = function () {
        root.setAttribute("data-scheme", next);
        try { localStorage.setItem("pawtrol-site-theme", next); } catch (err) {}
      };
      if (!document.startViewTransition || reduced) return apply();
      var r = toggle.getBoundingClientRect();
      var x = r.left + r.width / 2, y = r.top + r.height / 2;
      var end = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      document.startViewTransition(apply).ready.then(function () {
        root.animate(
          { clipPath: ["circle(0 at " + x + "px " + y + "px)", "circle(" + end + "px at " + x + "px " + y + "px)"] },
          { duration: 520, easing: "cubic-bezier(0.22, 1, 0.36, 1)", pseudoElement: "::view-transition-new(root)" }
        );
      });
    });
  }

  /* ─── Copy buttons ─────────────────────────────────────────────────── */
  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy");
      var done = function () {
        btn.classList.add("copied");
        btn.setAttribute("aria-label", "Copied");
        setTimeout(function () { btn.classList.remove("copied"); btn.setAttribute("aria-label", "Copy address"); }, 1600);
      };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, done);
      else done();
    });
  });

  /* ─── Hero: scan the real screen, fill the cloud's copy ───────────── */
  var hero = document.querySelector("[data-hero]");
  if (hero) {
    var scan = hero.querySelector(".scan");
    var mock = hero.querySelector(".device .mock");
    var devRows = hero.querySelectorAll(".device [data-row]");
    var cloudRows = hero.querySelectorAll(".cloud .field[data-row]");
    var heroBtn = hero.querySelector("[data-hero-toggle]");
    var heroLabel = hero.querySelector("[data-hero-toggle-label]");
    var paused = false, raf = 0, t0 = 0, elapsed = 0, visible = true;
    var SWEEP = 3600, HOLD = 3200, RESET = 900, CYCLE = SWEEP + HOLD + RESET;

    function rowY(el) { return el.offsetTop + el.offsetHeight / 2; }

    function render(t) {
      var h = mock.offsetHeight;
      var phase = t % CYCLE;
      var y = phase < SWEEP ? (phase / SWEEP) * h : phase < SWEEP + HOLD ? h : -1;
      scan.style.opacity = phase < SWEEP ? "1" : "0";
      scan.style.transform = "translateY(" + Math.max(0, y) + "px)";
      devRows.forEach(function (el) {
        var hit = y >= rowY(el);
        el.classList.toggle("hit", hit && el.classList.contains("field"));
        var row = el.getAttribute("data-row");
        var c = hero.querySelector('.cloud .field[data-row="' + row + '"]');
        if (c) c.classList.toggle("in", hit);
      });
    }

    function showFinal() {
      scan.style.opacity = "0";
      devRows.forEach(function (el) { if (el.classList.contains("field")) el.classList.add("hit"); });
      cloudRows.forEach(function (el) { el.classList.add("in"); });
    }

    function loop(now) {
      if (!t0) t0 = now - elapsed;
      elapsed = now - t0;
      render(elapsed);
      raf = requestAnimationFrame(loop);
    }
    function play() { if (raf || paused || !visible) return; t0 = 0; raf = requestAnimationFrame(loop); }
    function stop() { cancelAnimationFrame(raf); raf = 0; }

    if (reduced) {
      showFinal();
      heroBtn.hidden = true;
    } else {
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
        visible ? play() : stop();
      }).observe(hero);
      heroBtn.addEventListener("click", function () {
        paused = !paused;
        heroBtn.setAttribute("aria-pressed", String(paused));
        heroLabel.textContent = paused ? "Play" : "Pause";
        if (paused) { stop(); showFinal(); } else { play(); }
      });
      play();
    }
  }

  /* ─── How it works: steps drive the sticky stage ──────────────────── */
  var stage = document.querySelector(".stage");
  var steps = document.querySelectorAll(".step");
  if (stage && steps.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        var n = en.target.getAttribute("data-step");
        stage.setAttribute("data-step", n);
        steps.forEach(function (s) { s.classList.toggle("active", s === en.target); });
      });
    }, { rootMargin: "-45% 0px -45% 0px" });
    steps.forEach(function (s) { io.observe(s); });
  }

  /* ─── Screenshot film: a chaptered, video-like player ─────────────── */
  var film = document.querySelector("[data-film]");
  if (film) {
    var CH = [
      { t: "Capture", d: "Pawtrol takes a screenshot of the tab it’s working in. Its own on-page button hides first, so it never ends up in the picture." },
      { t: "Find text", d: "A text detector (PP-OCRv4, 1.3 MB) finds every line of text, including text drawn inside images and canvases that page code can’t read." },
      { t: "Find faces", d: "A face detector (YuNet, 0.2 MB) finds faces in photos, video calls and scanned ID cards. Both models run on your GPU through WebGPU, or on the CPU if needed." },
      { t: "Mask", d: "ID numbers, names and phone numbers are covered with solid bars, and faces are blurred. The bars carry a plain label, never a fake number." },
      { t: "Verify", d: "Pawtrol reads the masked image again. If any sensitive text is still readable, or a check can’t run, the screenshot is dropped." },
      { t: "Send", d: "Only a verified, masked image is sent to the model. On banking pages, no screenshot is sent at all." }
    ];
    var DUR = 4000, TOTAL = DUR * CH.length;
    var btns = film.querySelectorAll(".chapters button");
    var playBtn = film.querySelector("[data-film-play]");
    var iPlay = playBtn.querySelector(".i-play"), iPause = playBtn.querySelector(".i-pause");
    var tc = film.querySelector("[data-film-tc]"), ttl = film.querySelector("[data-film-title]");
    var txt = film.querySelector("[data-film-text]"), time = film.querySelector("[data-film-time]");
    var pos = 0, playing = false, fr = 0, last = 0, cur = 0, userPaused = false, seen = false;

    function fmt(ms) { var s = Math.floor(ms / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }

    function setChapter(i) {
      if (i === cur) return;
      cur = i;
      film.setAttribute("data-ch", "0");
      void film.offsetWidth; // restart CSS animations for this chapter
      film.setAttribute("data-ch", String(i));
      var c = CH[i - 1];
      tc.textContent = String(i).padStart(2, "0") + " / 06";
      ttl.textContent = c.t;
      txt.textContent = c.d;
    }

    function paint() {
      var i = Math.min(CH.length, Math.floor(pos / DUR) + 1);
      setChapter(i);
      btns.forEach(function (b, k) {
        var f = b.querySelector(".fill");
        var start = k * DUR;
        var p = Math.max(0, Math.min(1, (pos - start) / DUR));
        f.style.width = (p * 100) + "%";
        b.classList.toggle("done", p >= 1);
        b.classList.toggle("current", k === i - 1);
      });
      time.textContent = fmt(pos) + " / " + fmt(TOTAL);
    }

    function tick(now) {
      if (!last) last = now;
      pos += now - last; last = now;
      if (pos >= TOTAL) { pos = TOTAL - 1; paint(); setPlaying(false); return; }
      paint();
      fr = requestAnimationFrame(tick);
    }

    function setPlaying(on) {
      playing = on;
      iPlay.style.display = on ? "none" : "";
      iPause.style.display = on ? "" : "none";
      playBtn.setAttribute("aria-label", on ? "Pause" : "Play");
      cancelAnimationFrame(fr); last = 0;
      if (on) { if (pos >= TOTAL - 1) { pos = 0; cur = 0; } fr = requestAnimationFrame(tick); }
    }

    playBtn.addEventListener("click", function () { userPaused = playing; setPlaying(!playing); });
    btns.forEach(function (b, k) {
      b.addEventListener("click", function () {
        pos = k * DUR + (reduced ? DUR - 1 : 0);
        cur = 0;
        paint();
        if (!reduced && !playing) { userPaused = false; setPlaying(true); }
      });
    });

    if (reduced) {
      pos = TOTAL - 1; paint();
    } else {
      new IntersectionObserver(function (entries) {
        var vis = entries[0].isIntersecting;
        if (vis && !seen) { seen = true; setPlaying(true); }
        else if (vis && !userPaused && !playing && pos < TOTAL - 1) setPlaying(true);
        else if (!vis && playing) setPlaying(false);
      }, { threshold: 0.45 }).observe(film);
    }
  }
})();
