import 'temporal-polyfill/global';

import './globals.css';
import { render } from 'preact';
import { App } from './App';

render(
  <App />,
  document.getElementById('app')!,
);
