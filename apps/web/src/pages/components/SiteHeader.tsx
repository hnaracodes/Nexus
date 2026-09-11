import { useEffect, useRef, useState } from 'react';
import { Menu, X } from 'lucide-react';

const NAV_LINKS = [
  { href: '#how', label: 'How it works' },
  { href: '#governance', label: 'Governance' },
  { href: '/usage', label: 'Usage' },
  { href: '/download', label: 'Download' },
  { href: '/security', label: 'Security' },
  { href: '/privacy', label: 'Privacy' },
];

/**
 * Sticky header, transparent over the hero and gaining a surface once the
 * page scrolls. Mobile collapses to a disclosure menu (not a hover dropdown)
 * that traps focus while open and returns it to the toggle button on close.
 */
export function SiteHeader(): JSX.Element {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onScroll = (): void => setScrolled(globalThis.scrollY > 8);
    onScroll();
    globalThis.addEventListener('scroll', onScroll, { passive: true });
    return () => globalThis.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;

    const menu = menuRef.current;
    const focusables = menu?.querySelectorAll<HTMLElement>('a, button');
    focusables?.[0]?.focus();

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        toggleRef.current?.focus();
        return;
      }
      if (event.key !== 'Tab' || focusables === undefined || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuOpen]);

  return (
    <>
      <a
        href="#main"
        className="fixed left-2 top-2 z-50 -translate-y-16 rounded bg-accent px-4 py-2 text-sm font-medium text-bg transition-transform focus:translate-y-0"
      >
        Skip to content
      </a>

      <header
        className={`sticky top-0 z-10 transition-colors duration-150 ${
          scrolled ? 'border-b border-border bg-bg/80 backdrop-blur' : 'bg-transparent'
        }`}
      >
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <a href="/" className="font-mono text-lg font-semibold tracking-tight text-fg">
            syncode
          </a>

          <nav aria-label="Primary" className="hidden items-center gap-6 md:flex">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="text-sm text-fg-muted transition-colors duration-150 hover:text-fg"
              >
                {link.label}
              </a>
            ))}
            <a
              href="/new"
              className="min-h-[44px] rounded-md bg-accent px-4 py-2 text-sm font-medium leading-[28px] text-bg transition-colors duration-150 hover:bg-accent-dim hover:text-fg"
            >
              Open a room
            </a>
          </nav>

          <button
            ref={toggleRef}
            type="button"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            aria-controls="site-mobile-menu"
            onClick={() => setMenuOpen((open) => !open)}
            className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-fg md:hidden"
          >
            {menuOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
          </button>
        </div>

        {menuOpen && (
          <div
            id="site-mobile-menu"
            ref={menuRef}
            className="border-t border-border bg-bg px-4 pb-4 md:hidden"
          >
            <nav aria-label="Mobile" className="flex flex-col gap-1 pt-2">
              {NAV_LINKS.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={() => setMenuOpen(false)}
                  className="rounded-md px-2 py-3 text-sm text-fg-muted hover:bg-surface hover:text-fg"
                >
                  {link.label}
                </a>
              ))}
              <a
                href="/new"
                onClick={() => setMenuOpen(false)}
                className="mt-2 rounded-md bg-accent px-4 py-3 text-center text-sm font-medium text-bg"
              >
                Open a room
              </a>
            </nav>
          </div>
        )}
      </header>
    </>
  );
}
