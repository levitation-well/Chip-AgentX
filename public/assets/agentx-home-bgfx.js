(function () {
  'use strict';

  var canvas = document.querySelector('[data-agentx-bgfx]');
  if (!canvas || !canvas.getContext) {
    return;
  }

  var ctx = canvas.getContext('2d');
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var width = 0;
  var height = 0;
  var points = [];
  var frameId = 0;
  var accent = [15, 118, 110];

  function parseColor(value) {
    var probe = document.createElement('span');
    probe.style.color = value;
    document.body.appendChild(probe);
    var computed = getComputedStyle(probe).color;
    probe.remove();
    var match = computed.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (match) {
      accent = [Number(match[1]), Number(match[2]), Number(match[3])];
    }
  }

  function refreshColor() {
    var rootStyle = getComputedStyle(document.documentElement);
    parseColor(rootStyle.getPropertyValue('--accent').trim() || '#0f766e');
  }

  function resize() {
    width = canvas.clientWidth || window.innerWidth;
    height = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var count = Math.max(24, Math.min(68, Math.round((width * height) / 26000)));
    points = Array.from({ length: count }, function () {
      return {
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.22,
        vy: (Math.random() - 0.5) * 0.22
      };
    });
    if (points.length > 2) {
      points[0] = { x: Math.min(34, width * 0.18), y: Math.min(34, height * 0.14), vx: 0.05, vy: 0.04 };
      points[1] = { x: Math.min(148, width * 0.48), y: Math.min(86, height * 0.22), vx: -0.04, vy: 0.03 };
      points[2] = { x: Math.min(220, width * 0.72), y: Math.min(128, height * 0.34), vx: 0.03, vy: -0.04 };
    }
  }

  function rgba(alpha) {
    return 'rgba(' + accent[0] + ',' + accent[1] + ',' + accent[2] + ',' + alpha + ')';
  }

  function draw() {
    ctx.clearRect(0, 0, width, height);

    for (var i = 0; i < points.length; i += 1) {
      var p = points[i];
      if (!reduce) {
        p.x += p.vx;
        p.y += p.vy;
      }
      if (p.x < -16) p.x = width + 16;
      if (p.x > width + 16) p.x = -16;
      if (p.y < -16) p.y = height + 16;
      if (p.y > height + 16) p.y = -16;
    }

    var link = width < 720 ? 108 : 138;
    for (var a = 0; a < points.length; a += 1) {
      for (var b = a + 1; b < points.length; b += 1) {
        var dx = points[a].x - points[b].x;
        var dy = points[a].y - points[b].y;
        var distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < link) {
          ctx.strokeStyle = rgba(((1 - distance / link) * 0.1).toFixed(3));
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(points[a].x, points[a].y);
          ctx.lineTo(points[b].x, points[b].y);
          ctx.stroke();
        }
      }
    }

    for (var k = 0; k < points.length; k += 1) {
      ctx.beginPath();
      ctx.arc(points[k].x, points[k].y, 1.6, 0, Math.PI * 2);
      ctx.fillStyle = rgba('0.24');
      ctx.fill();
    }

    if (!reduce) {
      frameId = window.requestAnimationFrame(draw);
    }
  }

  function start() {
    window.cancelAnimationFrame(frameId);
    refreshColor();
    resize();
    draw();
  }

  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(start, 140);
  });
  window.addEventListener('agentx-skin-change', function () {
    window.setTimeout(start, 20);
  });

  start();
})();