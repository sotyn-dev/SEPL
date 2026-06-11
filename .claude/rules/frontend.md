---
paths: ["client/**/*"]
description: Frontend conventions for React+Vite SPA
---

# Frontend Rules (React + Vite + Tailwind)

## Component Organization

- **Folder structure**: `src/components/` for reusable components, `src/pages/` for routes
- **Naming**: PascalCase files for components (`Button.jsx`, `UserForm.jsx`), camelCase for utilities
- **File size**: Components <300 LOC, pages <500 LOC — split if larger
- **Export**: Default export for the component, named exports for helpers only if reused

## React & Hooks

- Use functional components + hooks exclusively (no class components)
- Custom hooks in `src/hooks/` with `use` prefix (e.g., `useAuth.js`)
- Avoid deeply nested ternaries — extract sub-components instead
- Use `React.memo` only when you've measured re-render cost

## Styling (Tailwind CSS)

- Use Tailwind utilities — no inline CSS in JSX
- Responsive: `sm:`, `md:`, `lg:` prefixes; mobile-first approach
- Color constants: define in `tailwind.config.js`, not hardcoded
- Space/sizing: use Tailwind scale (4px base unit: `p-2`, `w-12`, etc.)

## Accessibility

- **Semantic HTML**: Use `<button>`, `<nav>`, `<main>`, `<form>` instead of divs
- **ARIA labels**: Forms must have `<label>` or `aria-label`, icons need `aria-label`
- **Keyboard**: All interactive elements must be focusable (tabindex if needed)
- **Color contrast**: Text must meet WCAG AA standards

## File Size Thresholds

- Components: max 300 LOC (split hooks, child components, utilities into separate files)
- Pages: max 500 LOC (extract modals, sidebars into components)
- Utilities: max 100 LOC (split into smaller modules)

## Error Handling & State

- Errors caught with Error Boundary wrapping page routes
- Form validation on blur + submit (not real-time keystroke)
- Loading states: use global Zustand store or context, never prop drilling
- API errors: logged to Sentry, user-facing message in toast (react-hot-toast)
