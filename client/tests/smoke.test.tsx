import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from '../src/App.js';

describe('App', () => {
  it('renders', () => {
    // phase-3c: with no room/token in the URL, App now renders the
    // CreateRoom landing page instead of the old bare "Nexus" placeholder.
    render(<App />);
    expect(screen.getByText(/open a nexus room/i)).toBeInTheDocument();
  });
});
