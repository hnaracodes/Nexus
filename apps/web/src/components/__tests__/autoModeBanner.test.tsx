import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AutoModeBanner } from '../AutoModeBanner.js';

describe('AutoModeBanner', () => {
  it('renders nothing while auto mode is off', () => {
    const { container } = render(<AutoModeBanner autoMode={null} onTurnOff={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says plainly that actions run without a vote, and who switched it on', () => {
    render(<AutoModeBanner autoMode={{ participantId: 'p_ada', displayName: 'Ada' }} onTurnOff={() => {}} />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent(/auto mode is on/i);
    expect(banner).toHaveTextContent(/without a vote/i);
    expect(banner).toHaveTextContent(/turned on by ada/i);
  });

  it('anyone can turn it off from the banner', () => {
    const onTurnOff = vi.fn();
    render(<AutoModeBanner autoMode={{ participantId: 'p_ada', displayName: 'Ada' }} onTurnOff={onTurnOff} />);
    fireEvent.click(screen.getByRole('button', { name: /turn off/i }));
    expect(onTurnOff).toHaveBeenCalledTimes(1);
  });
});
