/**
 * The panel's `cn` (clsx + tailwind-merge), reached the way every other panel component is: as a
 * global the panel put there. Importing it from the package is not an option — `adminizer/ui/*`
 * is types only (the runtime export was removed in 5.1.0-build.28 because it never resolved), and
 * bundling our own `tailwind-merge` would merge against a different class list than the panel's.
 *
 * The fallback keeps a module rendering on a panel too old to expose it: classes are concatenated
 * without conflict resolution, which is worse but not broken.
 */
export const cn: (...classes: Array<string | false | null | undefined>) => string =
  (window as any).cn ?? ((...classes) => classes.filter(Boolean).join(' '));

/**
 * The panel's own `sonner`, reached the same way and for the same reason: `vite.config.ts` maps
 * `sonner` to `window.sonner`, so a module that bundled its own copy would render into a
 * `<Toaster>` nobody mounted and silently show nothing.
 *
 * It is re-exported here rather than imported as `'sonner'` because the package is not a
 * dependency of this repository — the import resolves at build time through the externals plugin
 * and not at all for `tsc`.
 */
export const toast: {
  (message: string): void;
  success: (message: string) => void;
  error: (message: string) => void;
} = (window as any).sonner?.toast ?? Object.assign(
  (message: string) => console.info(message),
  { success: (message: string) => console.info(message), error: (message: string) => console.error(message) },
);
