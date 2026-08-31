(function() {
  'use strict';

  var counterId = 111319878;
  var guides = {
    '/guides/24-hours/': '24_hours',
    '/guides/team-relocation/': 'team_relocation',
    '/guides/team-relocation-form/': 'team_relocation_form',
    '/guides/north-cyprus-residence/': 'vnzh',
    '/guides/company-abroad/': 'company_abroad',
    '/guides/country-choice/': 'country_choice'
  };

  var pathname = window.location.pathname.replace(/\/+$/, '') + '/';
  var guide = guides[pathname];

  if (!guide) return;

  function getPlacement(button) {
    if (button.closest('.site-header')) return 'header';
    if (button.closest('.hero-actions')) return 'hero';
    if (button.closest('.compact-cta')) return 'content';
    if (button.closest('.inside-cta')) return 'inside_guide';
    if (button.closest('.final')) return 'final';
    return 'other';
  }

  function sendGoal(button) {
    if (typeof window.ym !== 'function') return;

    var params = {
      guide: guide,
      placement: getPlacement(button),
      button_text: button.textContent.trim().replace(/\s+/g, ' '),
      destination: button.href
    };

    window.ym(counterId, 'reachGoal', 'guide_cta_click', params);
    window.ym(counterId, 'reachGoal', 'guide_' + guide + '_cta', params);
  }

  document.addEventListener('click', function(event) {
    if (!(event.target instanceof Element)) return;

    var button = event.target.closest('a.btn');
    if (!button) return;

    sendGoal(button);
  }, true);
})();
