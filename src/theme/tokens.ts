/** Halqa design tokens — derived from the brand identity (see project/Halqa Design System.dc.html). */
export const color = {
  // Brand
  primary: '#124C46',
  primaryHover: '#0B332F',
  ivory: '#F7F3E8',
  sage: '#D8E5D7',
  gold: '#C6A66B',

  // Surfaces
  page: '#E9E4D6',
  card: '#FFFDF8',
  sunken: '#EAE5D8', // segmented-control track
  sand: '#EEE8DA',
  sageTint: '#EAF1E9',
  goldTint: '#FBF4E4',
  goldChip: '#F6EDDA',
  track: '#E6E0D2',
  takenSlot: '#EEEAE0',

  // Lines
  border: '#E6DFCF',
  borderStrong: '#CFC7B3',
  borderInput: '#D9D2C1',
  borderChip: '#DDD5C2',
  divider: '#EEE8DA',
  dividerHeader: '#EAE4D5',

  // Text
  ink: '#16302C',
  inkQuran: '#14231F',
  body: '#3E4F4A',
  muted: '#56665F',
  subtle: '#45534E',
  faint: '#8A958F',
  goldInk: '#7A6337',

  // Status
  danger: '#A23B2A',
  dangerInk: '#8E2F20',
  dangerDeep: '#7A2619',
  dangerBg: '#F5E1DC',
  dangerBorder: '#E3BDB4',
  dangerBtn: '#9A3324',
  leave: '#B33A2A',
  warnBg: '#F3E6CC',
  warnInk: '#6B470C',
  neutralBg: '#ECE7DB',
  disabledBtn: '#B7C2BC',

  // Live session (dark)
  liveBg: '#0C2421',
  liveTile: '#173A35',
  liveTileSelf: '#24504A',
  liveSub: '#C9D8C8',
  liveSub2: '#A9BFB9',
  liveWarn: '#F3D9A4',
  offlineBar: '#3A2E1A',
} as const;

export const font = {
  ui: 'Tajawal, sans-serif',
  latin: 'Manrope, sans-serif',
  quran: "'Amiri Quran', serif",
} as const;

export const radius = { sm: 10, md: 12, lg: 14, xl: 16, xxl: 20, pill: 999 } as const;

/** Minimum touch target (px). */
export const touch = 48;
