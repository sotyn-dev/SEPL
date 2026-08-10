/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['"DM Sans"', 'system-ui', 'sans-serif'],
      },
      colors: {
        ink: '#0f172a',
        paper: '#f4f6f8',
        accent: '#0d9488',
      },
    },
  },
  plugins: [],
};
