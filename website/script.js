(() => {
  'use strict';

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- theme toggle ----------
  const themeToggle = document.getElementById('theme-toggle');
  const root = document.documentElement;
  const STORAGE_KEY = 'rizo-theme';

  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') {
    root.setAttribute('data-theme', stored);
  }

  themeToggle.addEventListener('click', () => {
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const current = root.getAttribute('data-theme') || (systemDark ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    localStorage.setItem(STORAGE_KEY, next);
  });

  // ---------- copy install command ----------
  const copyBtn = document.getElementById('copy-install');
  const installCmd = 'code --install-extension ChaitanyaAggarwal.rizo';

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(installCmd);
      const original = copyBtn.innerHTML;
      copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>';
      copyBtn.setAttribute('aria-label', 'Copied');
      setTimeout(() => {
        copyBtn.innerHTML = original;
        copyBtn.setAttribute('aria-label', 'Copy install command');
      }, 1600);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — command is
      // still selectable/copyable by hand, so fail silently.
    }
  });

  // ---------- reveal on scroll ----------
  const revealEls = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !prefersReducedMotion) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.15 },
    );
    revealEls.forEach((el) => io.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add('in'));
  }

  // ---------- routing diagram: dots flowing along the paths ----------
  const paths = ['path-1', 'path-2', 'path-3'].map((id) => document.getElementById(id));
  const dots = ['dot-1', 'dot-2', 'dot-3'].map((id) => document.getElementById(id));

  if (paths.every(Boolean) && dots.every(Boolean)) {
    if (prefersReducedMotion) {
      // Static: park each dot at its path's midpoint instead of animating.
      paths.forEach((path, i) => {
        const len = path.getTotalLength();
        const pt = path.getPointAtLength(len * 0.5);
        dots[i].setAttribute('cx', pt.x);
        dots[i].setAttribute('cy', pt.y);
      });
    } else {
      const lengths = paths.map((p) => p.getTotalLength());
      const DURATION_MS = 2600;
      const STAGGER_MS = [0, 550, 1100];

      function frame(now) {
        paths.forEach((path, i) => {
          const t = ((now + STAGGER_MS[i]) % DURATION_MS) / DURATION_MS;
          const pt = path.getPointAtLength(lengths[i] * t);
          dots[i].setAttribute('cx', pt.x);
          dots[i].setAttribute('cy', pt.y);
          dots[i].style.opacity = t > 0.94 ? String((1 - t) / 0.06) : t < 0.06 ? String(t / 0.06) : '1';
        });
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    }
  }
})();
