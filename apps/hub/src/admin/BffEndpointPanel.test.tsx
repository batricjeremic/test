import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { BFF_BASE_URL_SETTING_KEY } from '../api';
import { createFakeHubHost, HostProvider } from '../sdk';
import type { FakeHubHost } from '../sdk';
import { BffEndpointPanel } from './BffEndpointPanel';

function renderPanel(host: FakeHubHost) {
  return render(
    <HostProvider host={host}>
      <BffEndpointPanel />
    </HostProvider>,
  );
}

describe('BffEndpointPanel', () => {
  it('says so when no endpoint is set and the build default is in use', async () => {
    const host = createFakeHubHost();
    renderPanel(host);

    const notice = await screen.findByTestId('endpoint-source');
    expect(notice).toHaveTextContent(/no endpoint is set/i);
    expect(notice).toHaveTextContent('http://localhost:8080');
  });

  it('reports an endpoint set for the organisation', async () => {
    const host = createFakeHubHost({
      settings: { [BFF_BASE_URL_SETTING_KEY]: 'https://staging.example.com' },
    });
    renderPanel(host);

    await waitFor(() =>
      expect(screen.getByTestId('endpoint-source')).toHaveTextContent(
        /set for this organisation/i,
      ),
    );
    expect(screen.getByLabelText(/endpoint url/i)).toHaveValue(
      'https://staging.example.com',
    );
  });

  it('saves a new endpoint organisation-wide', async () => {
    const user = userEvent.setup();
    const host = createFakeHubHost();
    renderPanel(host);
    await screen.findByTestId('endpoint-source');

    const field = screen.getByLabelText(/endpoint url/i);
    await user.clear(field);
    await user.type(field, 'https://board-api.example.com');
    await user.click(screen.getByRole('button', { name: /save endpoint/i }));

    await waitFor(() =>
      expect(host.settings[BFF_BASE_URL_SETTING_KEY]).toBe(
        'https://board-api.example.com',
      ),
    );
    // It changes the client the NEXT time the hub loads, not this session —
    // saying otherwise would be a lie the user could act on.
    expect(await screen.findByRole('status')).toHaveTextContent(
      /next time the hub is opened/i,
    );
  });

  it('blocks saving an invalid URL and names the problem', async () => {
    const user = userEvent.setup();
    const host = createFakeHubHost();
    renderPanel(host);
    await screen.findByTestId('endpoint-source');

    const field = screen.getByLabelText(/endpoint url/i);
    await user.clear(field);
    await user.type(field, '/api');

    expect(await screen.findByRole('alert')).toHaveTextContent(/absolute URL/i);
    expect(
      screen.getByRole('button', { name: /save endpoint/i }),
    ).toBeDisabled();
    expect(host.settings[BFF_BASE_URL_SETTING_KEY]).toBeUndefined();
  });

  it('surfaces a failed write rather than reporting success', async () => {
    const user = userEvent.setup();
    const host = createFakeHubHost();
    host.failNextSettingWrite(new Error('the host rejected the write'));
    renderPanel(host);
    await screen.findByTestId('endpoint-source');

    const field = screen.getByLabelText(/endpoint url/i);
    await user.clear(field);
    await user.type(field, 'https://board-api.example.com');
    await user.click(screen.getByRole('button', { name: /save endpoint/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /rejected the write/i,
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
