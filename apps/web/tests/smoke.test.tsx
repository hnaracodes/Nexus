import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import App from '../src/App.js';
import { Router } from '../src/router.js';

describe('App', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/');
  });
  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('renders a malformed-link page when reached with no room/token', () => {
    // phase-5a/5b: the router (not App) now owns "/" — App is room-only and
    // only ever renders for a room link, complete or not.
    render(<App />);
    expect(screen.getByText(/this room link is incomplete/i)).toBeInTheDocument();
  });
});

describe('Router', () => {
  it('mounts the marketing landing page at "/"', () => {
    render(<Router />);
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    // The security model belongs on the page, not only in the README.
    expect(screen.getByText(/shared security boundary/i)).toBeInTheDocument();
  });

  it('mounts room creation at "/new"', () => {
    window.history.pushState({}, '', '/new');
    render(<Router />);
    expect(screen.getByText(/open a syncode room/i)).toBeInTheDocument();
  });
});
