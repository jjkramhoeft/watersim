// Minimal hand-drawn stroke icons (24x24, currentColor).
const P = {
  push: '<path d="M4 15c2.5-3 5-3 7.5 0s5 3 8.5-1"/><path d="M4 10c2.5-3 5-3 7.5 0"/><path d="M16.5 6.5 20 9l-3.5 2.5"/><path d="M13 9h7"/>',
  splash: '<path d="M12 21c-3 0-5-2-5-4.5C7 13 12 8 12 8s5 5 5 8.5c0 2.5-2 4.5-5 4.5Z"/><path d="M5 9 3.5 6.5M19 9l1.5-2.5M12 4.5V2.5M8 5.5 7 3.5M16 5.5l1-2"/>',
  vortex: '<path d="M12 12a1.5 1.5 0 1 1 1.5-1.5"/><path d="M13.5 10.5A4 4 0 1 0 9 14"/><path d="M9 14a6.5 6.5 0 1 0 2-12.3"/><path d="M11 1.7C6 2.5 3 6.5 3.5 11"/>',
  magnet: '<path d="M6 3v8a6 6 0 0 0 12 0V3"/><path d="M6 7h4M14 7h4"/><path d="M10 3v8a2 2 0 0 0 4 0V3"/>',
  pour: '<path d="M4 6h9a3 3 0 0 1 3 3v1"/><path d="M4 3v6"/><path d="M16 14c0 0-2 2.6-2 4a2 2 0 0 0 4 0c0-1.4-2-4-2-4Z"/><path d="M19 10h2"/>',
  drain: '<ellipse cx="12" cy="17" rx="8" ry="3"/><path d="M8.5 17c0-1 1.6-1.7 3.5-1.7s3.5.7 3.5 1.7"/><path d="M12 3v8"/><path d="m8.5 7.5 3.5 3.5 3.5-3.5"/>',
  ball: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5c3 2.5 3 14.5 0 17"/><path d="M3.8 10c5 1.5 11.4 1.5 16.4 0"/>',
  shake: '<rect x="6.5" y="8" width="11" height="9" rx="1"/><path d="M6.5 12.5h11"/><path d="M3 9.5v5M21 9.5v5M1 11v2M23 11v2"/>',
  play: '<path d="M7 4.5v15l12-7.5Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  step: '<path d="M6 5v14l9-7Z"/><path d="M18 5v14"/>',
  reset: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3 3.5V9h5.5"/>',
  quake: '<path d="M2 12h3l2-6 3 12 3-9 2 5 2-2h5"/>',
  camera: '<path d="M4 8h3l1.5-2.5h7L17 8h3v11H4Z"/><circle cx="12" cy="13" r="3.5"/>',
  record: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4" fill="currentColor"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/>',
  fullscreen: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 0 1 4.9.7c0 1.7-2.4 2.1-2.4 3.8"/><path d="M12 17h.01"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  scenes: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 14c3-2 5-2 9 0s6 2 9 0"/>',
  physics: '<circle cx="12" cy="12" r="2"/><path d="M12 3c-4.5 0-6 4-6 9s1.5 9 6 9 6-4 6-9-1.5-9-6-9Z" transform="rotate(60 12 12)"/><path d="M12 3c-4.5 0-6 4-6 9s1.5 9 6 9 6-4 6-9-1.5-9-6-9Z" transform="rotate(-60 12 12)"/>',
  palette: '<path d="M12 3a9 9 0 0 0 0 18c1.2 0 1.8-.9 1.8-1.8 0-1.2-1-1.6-1-2.6 0-1 .8-1.6 1.8-1.6H17a4 4 0 0 0 4-4C21 6.5 17 3 12 3Z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>',
  gauge: '<path d="M4.5 17a8.5 8.5 0 1 1 15 0"/><path d="m12 13 4-5"/><circle cx="12" cy="13" r="1.3"/>',
  wave: '<path d="M2 12c2.5-4 5-4 7.5 0s5 4 7.5 0 3.5-3 5-2"/><path d="M2 18c2.5-4 5-4 7.5 0s5 4 7.5 0 3.5-3 5-2"/>',
  tilt: '<path d="M3 17 21 7"/><path d="M12 12v8"/><path d="M8 20h8"/>',
  droplet: '<path d="M12 21a6 6 0 0 0 6-6c0-4-6-11-6-11S6 11 6 15a6 6 0 0 0 6 6Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  cube: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z"/><path d="M12 12 20 7.5M12 12 4 7.5M12 12v9"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
};

export function icon(name, cls = '') {
  const body = P[name] || '';
  const fill = name === 'play' || name === 'step' ? ' fill="currentColor"' : '';
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><g${fill}>${body}</g></svg>`;
}
