import { render, screen, fireEvent } from '@testing-library/preact';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import * as fs from 'fs';
import * as path from 'path';

// These wrappers now render @radix-ui/themes components, so the tests assert
// behavior (roles, tags, events, prop passthrough) rather than specific Tailwind
// classes, which are no longer emitted by the components themselves.

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

describe('Button', () => {
  it('renders a button with its label', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button', { name: 'Click me' })).toBeDefined();
  });

  it.each(['default', 'destructive', 'outline', 'ghost', 'secondary'] as const)(
    'renders %s variant as a button',
    (variant) => {
      render(<Button variant={variant}>{variant}</Button>);
      expect(screen.getByRole('button', { name: variant })).toBeDefined();
    }
  );

  it('renders sm size as a button', () => {
    render(<Button size="sm">Small</Button>);
    expect(screen.getByRole('button', { name: 'Small' })).toBeDefined();
  });

  it('renders icon size as a button (IconButton)', () => {
    render(<Button size="icon">X</Button>);
    expect(screen.getByRole('button', { name: 'X' })).toBeDefined();
  });

  it('forwards onClick handler', () => {
    const onClick = jest.fn();
    render(<Button onClick={onClick}>Click</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Click' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders as disabled', () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByRole('button', { name: 'Disabled' })).toHaveProperty('disabled', true);
  });

  it('merges custom className', () => {
    render(<Button className="custom-class">Styled</Button>);
    expect(screen.getByRole('button', { name: 'Styled' }).className).toContain('custom-class');
  });
});

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

describe('Badge', () => {
  it.each(['default', 'secondary', 'destructive', 'outline'] as const)(
    'renders %s variant with its text',
    (variant) => {
      render(<Badge variant={variant}>{variant}</Badge>);
      expect(screen.getByText(variant)).toBeDefined();
    }
  );

  it('merges custom className', () => {
    render(<Badge className="my-badge">Custom</Badge>);
    expect(screen.getByText('Custom').className).toContain('my-badge');
  });
});

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

describe('Input', () => {
  it('renders a text input by default', () => {
    render(<Input placeholder="Name" />);
    expect((screen.getByPlaceholderText('Name') as HTMLInputElement).tagName).toBe('INPUT');
  });

  it('renders with specified type', () => {
    render(<Input type="email" placeholder="Email" />);
    expect((screen.getByPlaceholderText('Email') as HTMLInputElement).type).toBe('email');
  });

  it('forwards value and onInput', () => {
    const onInput = jest.fn();
    render(<Input value="hello" onInput={onInput} />);
    const input = screen.getByDisplayValue('hello') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'world' } });
    expect(onInput).toHaveBeenCalled();
  });

  it('applies disabled state', () => {
    render(<Input disabled placeholder="Disabled" />);
    expect((screen.getByPlaceholderText('Disabled') as HTMLInputElement).disabled).toBe(true);
  });

  it('merges custom className', () => {
    const { container } = render(<Input className="wide-input" placeholder="Wide" />);
    expect(container.querySelector('.wide-input')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Textarea
// ---------------------------------------------------------------------------

describe('Textarea', () => {
  it('renders a textarea element', () => {
    render(<Textarea placeholder="Description" />);
    expect(screen.getByPlaceholderText('Description').tagName).toBe('TEXTAREA');
  });

  it('applies disabled state', () => {
    render(<Textarea disabled placeholder="No edit" />);
    expect((screen.getByPlaceholderText('No edit') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('merges custom className', () => {
    const { container } = render(<Textarea className="tall" placeholder="Tall" />);
    expect(container.querySelector('.tall')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Alert
// ---------------------------------------------------------------------------

describe('Alert', () => {
  it('renders with role="alert"', () => {
    render(<Alert>Something happened</Alert>);
    expect(screen.getByRole('alert')).toBeDefined();
  });

  it.each(['default', 'destructive', 'success'] as const)('renders %s variant', (variant) => {
    render(<Alert variant={variant}>msg</Alert>);
    expect(screen.getByRole('alert')).toBeDefined();
  });

  it('renders title and description text', () => {
    render(
      (
        <Alert>
          <AlertTitle>Title</AlertTitle>
          <AlertDescription>Description text</AlertDescription>
        </Alert>
      ) as any
    );
    expect(screen.getByText('Title')).toBeDefined();
    expect(screen.getByText('Description text')).toBeDefined();
  });

  it('merges custom className', () => {
    render(<Alert className="my-alert">Test</Alert>);
    expect(screen.getByRole('alert').className).toContain('my-alert');
  });
});

// ---------------------------------------------------------------------------
// Z-index layering: Themes popovers must render above the Sheet (z-[200]).
// Themes popper content uses .rt-PopperContent, lifted in globals.css.
// ---------------------------------------------------------------------------

describe('z-index layering', () => {
  function zIndices(src: string): number[] {
    const out: number[] = [];
    for (const m of src.matchAll(/\bz-(\d+|\[\d+\])/g)) {
      const raw = m[1];
      out.push(raw.startsWith('[') ? parseInt(raw.slice(1, -1)) : parseInt(raw));
    }
    return out;
  }

  it('sheet.tsx z-index is 200', () => {
    const src = fs.readFileSync(path.join(__dirname, 'sheet.tsx'), 'utf-8');
    const zs = zIndices(src);
    expect(zs.length).toBeGreaterThan(0);
    for (const z of zs) expect(z).toBe(200);
  });

  it('globals.css lifts Themes popper content above the sheet (z > 200)', () => {
    const css = fs.readFileSync(path.join(__dirname, '../../globals.css'), 'utf-8');
    const m = css.match(/\.rt-PopperContent\s*\{[^}]*z-index:\s*(\d+)/);
    expect(m).toBeTruthy();
    expect(parseInt(m![1])).toBeGreaterThan(200);
  });
});
