import { SiteHeader } from './components/SiteHeader.js';
import { SiteFooter } from './components/SiteFooter.js';
import { Reveal } from './components/Reveal.js';
import { Hero } from './sections/Hero.js';
import { Problem } from './sections/Problem.js';
import { LiveDemo } from './sections/LiveDemo.js';
import { HowItWorks } from './sections/HowItWorks.js';
import { Governance } from './sections/Governance.js';
import { Invariants } from './sections/Invariants.js';
import { SecurityHonesty } from './sections/SecurityHonesty.js';
import { CinematicIntro } from './components/CinematicIntro.js';
import { SynCodeWanderer } from '../components/SynCodeBlob.js';

export function Landing(): JSX.Element {
  return (
    <div className="min-h-screen bg-bg text-fg">
      {/*
        Both of these are overlays on a page that is already complete beneath
        them. The intro never gates the content — a crawler, a JS failure, or a
        reduced-motion preference all land straight on the hero — and SynCode is
        pointer-events:none so he can never intercept a click meant for a CTA.
      */}
      <CinematicIntro />
      <SynCodeWanderer />
      <SiteHeader />
      <main id="main">
        {/* The hero manages its own reveal so its copy can stagger. */}
        <Hero />
        {/* The demo sits directly under the hero on purpose: the page's job is
            to show the product working, and every paragraph below this is
            easier to believe once you have watched the sequence once. */}
        <Reveal>
          <LiveDemo />
        </Reveal>
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
