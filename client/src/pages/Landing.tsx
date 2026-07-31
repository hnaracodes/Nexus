import { SiteHeader } from './components/SiteHeader.js';
import { SiteFooter } from './components/SiteFooter.js';
import { Reveal } from './components/Reveal.js';
import { Hero } from './sections/Hero.js';
import { Problem } from './sections/Problem.js';
import { HowItWorks } from './sections/HowItWorks.js';
import { Governance } from './sections/Governance.js';
import { Invariants } from './sections/Invariants.js';
import { SecurityHonesty } from './sections/SecurityHonesty.js';

export function Landing(): JSX.Element {
  return (
    <div className="min-h-screen bg-bg text-fg">
      <SiteHeader />
      <main id="main">
        {/* The hero manages its own reveal so its copy can stagger. */}
        <Hero />
        <Reveal>
          <Problem />
        </Reveal>
        <Reveal>
          <HowItWorks />
        </Reveal>
        <Reveal>
          <Governance />
        </Reveal>
        <Reveal>
          <Invariants />
        </Reveal>
        <SecurityHonesty />
      </main>
      <SiteFooter />
    </div>
  );
}
