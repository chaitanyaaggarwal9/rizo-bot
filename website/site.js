// rizobot.com: menu, copy buttons, and analytics consent.
//
// Google Analytics loads only after the visitor chooses "Accept". It never
// loads when the browser sends Global Privacy Control or Do Not Track, and
// it runs with Google signals and ad personalization off. The choice is
// kept in localStorage and can be changed from "Cookie settings" in the
// footer. See /privacy.
(function () {
  'use strict';

  var GA_ID = 'G-S37XL7PTJH';
  var KEY = 'rizo-analytics-consent';

  // ---------- mobile menu ----------
  var toggle = document.querySelector('.menu-toggle');
  var nav = document.getElementById('site-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  // ---------- copy buttons ----------
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy') || '';
      var done = function () {
        var old = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(function () { btn.textContent = old; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {});
      }
    });
  });

  // ---------- consent ----------
  function storage(get, value) {
    try {
      if (get) return window.localStorage.getItem(KEY);
      window.localStorage.setItem(KEY, value);
    } catch (e) {
      return null;
    }
    return null;
  }

  var optedOut =
    navigator.globalPrivacyControl === true ||
    navigator.doNotTrack === '1' ||
    window.doNotTrack === '1';

  var loaded = false;
  function loadAnalytics() {
    if (loaded || optedOut) return;
    loaded = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('consent', 'default', {
      analytics_storage: 'granted',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    });
    window.gtag('js', new Date());
    window.gtag('config', GA_ID, {
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
    });
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
  }

  // Named events for the links that matter (install, GitHub, npm).
  document.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('[data-event]') : null;
    if (a && loaded && window.gtag) {
      window.gtag('event', a.getAttribute('data-event'), { label: a.getAttribute('data-label') || '' });
    }
  });

  var banner = document.getElementById('consent');
  function showBanner() {
    if (!banner) return;
    var gpcNote = banner.querySelector('[data-gpc]');
    if (gpcNote) gpcNote.hidden = !optedOut;
    var accept = banner.querySelector('[data-consent="accept"]');
    if (accept) accept.hidden = optedOut;
    banner.hidden = false;
  }
  function decide(value) {
    storage(false, value);
    if (banner) banner.hidden = true;
    if (value === 'granted') loadAnalytics();
    else if (loaded) {
      // Already running this visit: stop storing and reload without it.
      window.gtag('consent', 'update', { analytics_storage: 'denied' });
      window.location.reload();
    }
  }

  if (banner) {
    banner.querySelector('[data-consent="accept"]').addEventListener('click', function () { decide('granted'); });
    banner.querySelector('[data-consent="reject"]').addEventListener('click', function () { decide('denied'); });
  }
  document.querySelectorAll('[data-cookie-settings]').forEach(function (b) {
    b.addEventListener('click', showBanner);
  });

  var choice = storage(true);
  if (optedOut) {
    // The browser already said no: respect it without asking.
  } else if (choice === 'granted') {
    loadAnalytics();
  } else if (choice !== 'denied') {
    showBanner();
  }
})();
