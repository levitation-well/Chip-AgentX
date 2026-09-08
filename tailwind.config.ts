import type { Config } from 'tailwindcss';
import { createTailwindPreset } from 'glasscn-ui';

const glasscnPreset = createTailwindPreset({
  baseRadius: '0.75rem',
  colors: {
    primary: 'emerald',
    secondary: 'cyan',
    danger: 'red',
    warning: 'amber',
    background: {
      light: '#f7faf8',
      dark: '#06140d'
    },
    foreground: {
      light: '#111827',
      dark: '#ecfdf5'
    },
    foregroundMuted: {
      light: '#6b7280',
      dark: '#86efac'
    },
    border: {
      light: '#dce7df',
      dark: '#166534'
    },
    borderMuted: {
      light: '#edf3ef',
      dark: '#14532d'
    }
  }
});

export default {
  content: [
    './webui/**/*.{ts,tsx}',
    './public/**/*.{html,js}',
    './node_modules/glasscn-ui/dist/index.js'
  ],
  presets: [glasscnPreset],
  theme: {
    extend: {}
  }
} satisfies Config;
