/**
 * JSX intrinsic-element declarations for the @material/web custom elements
 * registered in md-elements.ts. Custom elements accept arbitrary attributes /
 * properties (icon, headline, slot, anchor, label, selected, …) and dispatch DOM
 * events, so each tag permits standard HTML attributes plus any extra prop. Keep
 * this in sync with the registered tags in md-elements.ts.
 *
 * NOTE: this file must NOT share a basename with a .ts source file (e.g.
 * `md-elements.d.ts` next to `md-elements.ts`) — TypeScript would treat it as that
 * module's declaration output and silently drop it from the program.
 */
import type { JSX } from 'preact';

type MdProps = JSX.HTMLAttributes<HTMLElement> & { [prop: string]: any };

declare module 'preact' {
  namespace JSX {
    interface IntrinsicElements {
      'md-fab': MdProps;
      'md-list': MdProps;
      'md-list-item': MdProps;
      'md-menu': MdProps;
      'md-menu-item': MdProps;
      'md-icon-button': MdProps;
      'md-icon': MdProps;
      'md-checkbox': MdProps;
      'md-slider': MdProps;
      'md-switch': MdProps;
      'md-divider': MdProps;
      'md-outlined-text-field': MdProps;
      'md-outlined-select': MdProps;
      'md-select-option': MdProps;
    }
  }
}
