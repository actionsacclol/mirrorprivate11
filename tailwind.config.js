/** @type {import('tailwindcss').Config} */
// Krypto Mirror's design system (2026-10-22): a calm fintech look — neutral
// surfaces, one blue accent, Inter, money in green and red. Token NAMES are
// kept from the Krypt kit so every inherited page keeps compiling; their
// VALUES live in src/index.css, with a light mode beside the dark one.
// New pages use the semantic names below (up / down / warn / accent).
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Parchment white — every text-white / border-white/10 in the app
        // becomes warm engraved bone on the cold void. Deliberate.
        // Since 2026-09-20 these read variables too, so a LOOK can move the
        // surfaces and the text colour the way a theme moves the accent —
        // and 1,036 alpha uses (bg-white/5, bg-krypt-panel/80 …) keep
        // working. Classic's values live in src/index.css under :root.
        // `black` too: bg-black/30 is the app's standard input and inset
        // wash, ~180 uses. A dark look leaves the ink at 0 0 0; the light
        // XP look tints it blue so those washes read as Luna, not soot.
        black: 'rgb(var(--krypt-ink) / <alpha-value>)',
        white: 'rgb(var(--krypt-text) / <alpha-value>)',
        'krypt-black': 'rgb(var(--krypt-black) / <alpha-value>)',
        'krypt-void': 'rgb(var(--krypt-void) / <alpha-value>)',
        'krypt-surface': 'rgb(var(--krypt-surface) / <alpha-value>)',
        'krypt-panel': 'rgb(var(--krypt-panel) / <alpha-value>)',
        'krypt-muted': 'rgb(var(--krypt-muted) / <alpha-value>)',
        // The ACCENT, and the only part of the palette a theme moves.
        // Channels rather than hex, so `<alpha-value>` keeps every existing
        // `bg-krypt-purple/20` working - 376 uses of krypt-purple alone, and
        // rewriting them would have been the wrong way to add a theme.
        // Values live in src/index.css under :root and html[data-theme].
        'krypt-indigo': 'rgb(var(--krypt-indigo) / <alpha-value>)',
        'krypt-purple': 'rgb(var(--krypt-accent) / <alpha-value>)',
        'krypt-pink': 'rgb(var(--krypt-accent-soft) / <alpha-value>)',
        'arc-gold': 'rgb(var(--warn) / <alpha-value>)',
        'arc-crimson': 'rgb(var(--down) / <alpha-value>)',
        // Semantic, for the Krypto Mirror pages: money up, money down, a
        // caution, and the one accent. Light and dark each set their own.
        up: 'rgb(var(--up) / <alpha-value>)',
        down: 'rgb(var(--down) / <alpha-value>)',
        warn: 'rgb(var(--warn) / <alpha-value>)',
        accent: 'rgb(var(--krypt-accent) / <alpha-value>)',
        bg: 'rgb(var(--krypt-void) / <alpha-value>)',
        card: 'rgb(var(--krypt-panel) / <alpha-value>)',
        raised: 'rgb(var(--krypt-surface) / <alpha-value>)',
        fg: 'rgb(var(--krypt-text) / <alpha-value>)',
        dim: 'rgb(var(--krypt-muted) / <alpha-value>)',
      },
      // Fonts read variables so a look can swap all three at once
      // (src/index.css). Classic: Spline Sans, Cinzel, JetBrains Mono.
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'Georgia', 'serif'],
        pixel: ['var(--font-display)', 'Georgia', 'serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      // Corners read variables so a look can square or soften every corner
      // at once. Classic's values are Tailwind's own.
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)',
      },
      // ── The type scale ────────────────────────────────────────────
      //
      // Added 2026-09-14. Before it, the app used EIGHT arbitrary pixel
      // sizes across 1,126 class names and TEN letter-spacings, with no
      // names — so "the uppercase label above a number" was written four
      // different ways depending on which page you were on. That reads as
      // carelessness long before anyone can say why.
      //
      // The values are the ones already in use, so naming them changes
      // nothing on screen. What changes is that there is now a right answer
      // to reach for, and `text-[10px]` in a review is a question.
      // Krypto Mirror reads at a desk, not on a trading wall: every step is a
      // pixel or two larger than Krypto Bot's dense terminal scale.
      fontSize: {
        nano: ['9px', { lineHeight: '1.35' }],    // badge text, nothing else
        micro: ['10px', { lineHeight: '1.4' }],   // dense table furniture
        label: ['11px', { lineHeight: '1.45' }],  // the small label above a value
        body: ['12px', { lineHeight: '1.55' }],   // the workhorse
        note: ['13px', { lineHeight: '1.6' }],    // descriptions, prose
        value: ['14px', { lineHeight: '1.4' }],   // a number you read
        figure: ['16px', { lineHeight: '1.35' }], // a number that is the point
      },
      // Inter is tight already; the wide engraved tracking of Krypto Bot's
      // Cinzel headings would read as shouting here.
      letterSpacing: {
        label: '0.04em',
        heading: '0.02em',
        display: '-0.015em',
        eyebrow: '0.08em',
        action: '0.02em',
      },
      // Hairlines and washes in Krypto Mirror's look sit between Tailwind's
      // 5 % steps (border-white/8, bg-white/[0.06] …). Without these steps
      // an unknown /8 silently falls back to the default border colour.
      opacity: {
        3: '0.03',
        4: '0.04',
        6: '0.06',
        7: '0.07',
        8: '0.08',
        12: '0.12',
      },
      // No glows in this look: depth is a soft shadow, focus is a ring.
      boxShadow: {
        'krypt-glow': '0 0 0 1px rgb(var(--krypt-accent) / 0.25)',
        'krypt-card': 'var(--shadow-card)',
        'gold-glow': 'none',
        'crimson-glow': 'none',
        soft: 'var(--shadow-card)',
        pop: 'var(--shadow-pop)',
      },
      backgroundImage: {
        'krypt-gradient': 'linear-gradient(135deg, rgb(var(--krypt-grad-from)) 0%, rgb(var(--krypt-grad-to)) 100%)',
        'krypt-radial': 'radial-gradient(1100px circle at 50% -14%, rgb(var(--krypt-accent) / 0.13), transparent 62%)',
      },
      animation: {
        'gradient-x': 'gradient-x 8s ease infinite',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fade-in 0.25s ease-out both',
        'pop-in': 'pop-in 0.18s cubic-bezier(0.2, 0.9, 0.3, 1.2) both',
        // fill-mode backwards: no retained transform/filter after the run —
        // a retained value would turn the page wrapper into a containing
        // block and break fixed-position drawers/modals inside it.
        'ink': 'ink 0.12s ease-out backwards',
        'rune-pulse': 'rune-pulse 2.6s ease-in-out infinite',
      },
      keyframes: {
        'gradient-x': { '0%, 100%': { backgroundPosition: '0% 50%' }, '50%': { backgroundPosition: '100% 50%' } },
        'fade-in': { from: { opacity: 0, transform: 'translateY(4px)' }, to: { opacity: 1, transform: 'translateY(0)' } },
        'pop-in': { from: { opacity: 0, transform: 'scale(0.95)' }, to: { opacity: 1, transform: 'scale(1)' } },
        'ink': { from: { opacity: 0 }, to: { opacity: 1 } },
        'rune-pulse': { '0%, 100%': { opacity: 0.35 }, '50%': { opacity: 1 } },
      },
    },
  },
  plugins: [],
};
