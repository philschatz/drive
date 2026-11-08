import { render } from '@testing-library/preact';
import { useRevealChange } from './useRevealChange';

function Host({ changes, ids }: { changes: object | null; ids: string[] }) {
  useRevealChange(changes, [ids]);
  return <ul>{ids.map(id => <li key={id} data-diff={id === 'x' ? 'added' : undefined}>{id}</li>)}</ul>;
}

describe('useRevealChange', () => {
  const proto = Element.prototype as any;
  let spy: jest.Mock;
  beforeEach(() => { spy = jest.fn(); proto.scrollIntoView = spy; });
  afterEach(() => { delete proto.scrollIntoView; });

  it('reveals the first marked element once per description, retrying until it renders', () => {
    const changes = {};
    const { rerender } = render(<Host changes={changes} ids={['a']} />);
    expect(spy).not.toHaveBeenCalled();           // nothing marked yet
    rerender(<Host changes={changes} ids={['a', 'x']} />);
    expect(spy).toHaveBeenCalledTimes(1);          // the marked row appeared
    rerender(<Host changes={changes} ids={['x', 'a']} />);
    expect(spy).toHaveBeenCalledTimes(1);          // same description: no second scroll
    rerender(<Host changes={{}} ids={['x', 'a']} />);
    expect(spy).toHaveBeenCalledTimes(2);          // a new description reveals again
    rerender(<Host changes={null} ids={['x']} />);
    expect(spy).toHaveBeenCalledTimes(2);          // history closed: nothing to reveal
  });
});
