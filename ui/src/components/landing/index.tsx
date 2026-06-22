// (CE) The hosted product ships rich art-directed marketing/landing components. The
// Community Edition is the app, not the marketing site — these are minimal functional
// stubs so the public/auth pages (login, sign-up, etc.) still render.
import type { ReactNode } from 'react';

export function AuroraBackground({ children }: { children?: ReactNode }) {
  return <div className="relative min-h-screen">{children}</div>;
}

export function SectionHeading({ children }: { children?: ReactNode }) {
  return <h2 className="text-2xl font-semibold tracking-tight">{children}</h2>;
}

export function LandingFooter() {
  return (
    <footer className="border-t border-foreground/10 py-8 text-center text-sm opacity-60">
      <p>
        Scrapalot Community Edition ·{' '}
        <a href="https://discord.gg/mmuCqzFXs7" className="underline">Discord</a> ·{' '}
        <a href="https://github.com/sime2408/scrapalot" className="underline">GitHub</a>
      </p>
      <p className="mt-1">AGPL-3.0 · © {new Date().getFullYear()} Scrapalot</p>
    </footer>
  );
}
