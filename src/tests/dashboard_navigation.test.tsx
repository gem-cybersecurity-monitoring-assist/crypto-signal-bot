import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ signOut: vi.fn(), user: { email: 'owner@example.test' } }),
  isSupabaseConfigured: false,
}));

vi.mock('@/lib/backend', () => ({
  describePaperExecutionError: vi.fn(),
  fetchBackendJson: vi.fn(),
}));

import { Header } from '@/components/dashboard/Header';

describe('owner dashboard navigation', () => {
  it('keeps the primary routes available in a horizontally scrollable narrow header', () => {
    render(
      <MemoryRouter initialEntries={['/portfolio']}>
        <Header />
      </MemoryRouter>,
    );

    const navigation = screen.getByRole('navigation', { name: 'Owner dashboard navigation' });
    expect(navigation).toHaveClass('overflow-x-auto');
    expect(
      ['Dashboard', 'Portfolio', 'Health', 'Audit', 'Settings']
        .map((label) => screen.getByRole('link', { name: label })),
    ).toHaveLength(5);
    expect(screen.getByRole('link', { name: 'Portfolio' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Portfolio' })).toHaveClass('shrink-0');
  });
});
