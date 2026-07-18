import { describe, expect, it } from 'vitest';

import { resolveRiftRepositoryName } from './RIFTWorkspaceManager.js';

describe('resolveRiftRepositoryName', () => {
    it('maps legacy monorepo aliases to canonical repo names', () => {
        expect(resolveRiftRepositoryName('medhok-monorepo')).toBe('core-app');
        expect(resolveRiftRepositoryName('batch-monorepo')).toBe('batch-jobs');
        expect(resolveRiftRepositoryName('client-services-monorepo')).toBe('client-services');
    });

    it('preserves canonical repo names', () => {
        expect(resolveRiftRepositoryName('core-app')).toBe('core-app');
        expect(resolveRiftRepositoryName('batch-jobs')).toBe('batch-jobs');
        expect(resolveRiftRepositoryName('provider-portal')).toBe('provider-portal');
    });
});
