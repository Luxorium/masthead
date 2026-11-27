// Unmounts components between tests so one test's DOM never leaks into the next.
import { cleanup } from '@testing-library/svelte';
import { afterEach } from 'vitest';

afterEach(() => cleanup());
