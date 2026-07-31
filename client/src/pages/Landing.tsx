import { SiteHeader } from './components/SiteHeader.js';
import { SiteFooter } from './components/SiteFooter.js';
import { Hero } from './sections/Hero.js';
import { Problem } from './sections/Problem.js';
import { HowItWorks } from './sections/HowItWorks.js';
import { Governance } from './sections/Governance.js';
import { Invariants } from './sections/Invariants.js';
import { SecurityHonesty } from './sections/SecurityHonesty.js';
import { Status } from './sections/Status.js';

export function Landing(): JSX.Element {
  return (
    <div className="min-h-screen bg-bg text-fg">
      <SiteHeader />
      <main id="main">
        <Hero />
        <Problem />
        <HowItWorks />
        <Governance />
        <Invariants />
        <SecurityHonesty />
        <Status />
      </main>
      <SiteFooter />
    </div>
  );
}
