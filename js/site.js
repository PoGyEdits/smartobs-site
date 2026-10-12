/* ============================================================
   Page behaviour: nav state, scroll reveals, screenshot tabs,
   and the email-then-download form.
   ============================================================ */
(function () {
  'use strict';


  /* ---------- sticky nav ---------- */

  var nav = document.getElementById('nav');
  var onScroll = function () {
    nav.classList.toggle('stuck', window.scrollY > 40);
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  /* ---------- scroll reveals ---------- */

  var revealables = document.querySelectorAll(
    '.band .eyebrow, .band .h2, .band .lede, .stage, .card, .feature-media, ' +
    '.mini-grid > div, .shots, .pack-copy, .pack-art, .beta-strip, .two-col'
  );
  revealables.forEach(function (el) { el.classList.add('reveal'); });

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        io.unobserve(e.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    revealables.forEach(function (el) { io.observe(el); });
  } else {
    revealables.forEach(function (el) { el.classList.add('in'); });
  }

  /* ---------- lazy video ----------
     Every loop past the hero is preload="none". Start them only once they
     are near the viewport, so the page does not pull ~10 MB up front. */

  var vids = document.querySelectorAll('video[preload="none"]');
  if ('IntersectionObserver' in window) {
    var vio = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var v = e.target;
        if (e.isIntersecting) {
          if (!v.dataset.started) {
            v.dataset.started = '1';
            v.load();
          }
          var p = v.play();
          if (p && p.catch) p.catch(function () {});
        } else if (v.dataset.started) {
          v.pause();
        }
      });
    }, { rootMargin: '200px' });
    vids.forEach(function (v) { vio.observe(v); });
  }

  /* ---------- screenshot tabs ---------- */

  var CAPTIONS = {
    'dashboard': 'Live process, map and netcon state, with an activity log of every action fired.',
    'smart-observer': 'Smart Observer: open the overlay, and set where the Player Camera sits.',
    'keybinds': 'The Keybind Explorer reads your config and lists which key flies which position.',
    'campath-library': 'The Campath Library sorts every campath by what it shows. Smart Observer goes by it.',
    'workspace': 'The BoltObserv minimap, embedded so the whole map stays in view.',
    'settings': 'Settings, with seven colour themes that recolour every window.',
    'shortcuts': 'Every in-app shortcut, rebindable to any key.',
    'addons': 'HLAE and BoltObserv install and update from inside the app.',
    'store': 'The Store, where the free MCR Pack installs itself into the right folders.'
  };

  var tabs = document.querySelectorAll('.shot-tabs button');
  var shotImg = document.getElementById('shot-img');
  var shotCap = document.getElementById('shot-caption');

  // Warm the images so switching tabs does not flash.
  tabs.forEach(function (t) {
    var pre = new Image();
    pre.src = 'assets/img/' + t.dataset.shot + '.jpg';
  });

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      tabs.forEach(function (t) { t.setAttribute('aria-selected', String(t === tab)); });
      var key = tab.dataset.shot;
      shotImg.src = 'assets/img/' + key + '.jpg';
      shotImg.alt = 'Smart Obs, ' + tab.textContent.trim();
      shotCap.textContent = CAPTIONS[key] || '';
    });
  });

  /* ---------- lightbox ----------
     The app fills a 2560x1440 window, so at column width its own type is
     too small to read. Rather than crop the product down to a detail, let
     people open the real thing. */

  var frame = document.querySelector('.shot-frame');
  var lb = document.createElement('div');
  lb.className = 'lb';
  lb.setAttribute('role', 'dialog');
  lb.setAttribute('aria-modal', 'true');
  lb.setAttribute('aria-label', 'Full size screenshot');
  lb.innerHTML = '<button class="lb-close" aria-label="Close">✕</button><img alt="">';
  document.body.appendChild(lb);
  var lbImg = lb.querySelector('img');
  var lastFocus = null;

  function openLb() {
    var key = document.querySelector('.shot-tabs button[aria-selected="true"]').dataset.shot;
    lbImg.src = 'assets/img/' + key + '.png';
    lbImg.alt = shotImg.alt;
    lastFocus = document.activeElement;
    lb.classList.add('open');
    lb.querySelector('.lb-close').focus();
  }
  function closeLb() {
    lb.classList.remove('open');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  frame.tabIndex = 0;
  frame.setAttribute('role', 'button');
  frame.setAttribute('aria-label', 'View screenshot full size');
  frame.addEventListener('click', openLb);
  frame.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLb(); }
  });
  lb.addEventListener('click', closeLb);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && lb.classList.contains('open')) closeLb();
  });

})();
