import nextVitals from 'eslint-config-next/core-web-vitals';
import config from '../../tooling/eslint-config/next.mjs';

const webConfig = [...nextVitals, ...config];

export default webConfig;
