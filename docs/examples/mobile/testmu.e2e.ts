import { test } from '@e2e-dev/mobile';
import { expect } from 'e2e';

test('Proverbial home screen', async ({ app, screen }) => {
  await app.open();
  await expect(screen.getByText('Proverbial')).toBeVisible();
  await expect(screen.getByRole('button', 'GEOLOCATION')).toBeVisible();
});
