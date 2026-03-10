import { render, screen, fireEvent } from '@testing-library/preact';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

describe('Button', () => {
  it('renders with default variant', () => {
    render(<Button>Click me</Button>);
    const btn = screen.getByRole('button', { name: 'Click me' });
    expect(btn).toBeDefined();
    expect(btn.className).toContain('bg-primary');
  });

  it('renders destructive variant', () => {
    render(<Button variant="destructive">Delete</Button>);
    const btn = screen.getByRole('button', { name: 'Delete' });
    expect(btn.className).toContain('bg-destructive');
  });

  it('renders outline variant', () => {
    render(<Button variant="outline">Outline</Button>);
    const btn = screen.getByRole('button', { name: 'Outline' });
    expect(btn.className).toContain('border');
  });

  it('renders ghost variant', () => {
    render(<Button variant="ghost">Ghost</Button>);
    const btn = screen.getByRole('button', { name: 'Ghost' });
    expect(btn.className).toContain('hover:bg-accent');
  });

  it('applies size classes', () => {
    render(<Button size="sm">Small</Button>);
    const btn = screen.getByRole('button', { name: 'Small' });
    expect(btn.className).toContain('h-8');
  });

  it('applies icon size', () => {
    render(<Button size="icon">X</Button>);
    const btn = screen.getByRole('button', { name: 'X' });
    expect(btn.className).toContain('w-9');
  });

  it('forwards onClick handler', () => {
    const onClick = jest.fn();
    render(<Button onClick={onClick}>Click</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Click' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders as disabled', () => {
    render(<Button disabled>Disabled</Button>);
    const btn = screen.getByRole('button', { name: 'Disabled' });
    expect(btn).toHaveProperty('disabled', true);
  });

  it('merges custom className', () => {
    render(<Button className="custom-class">Styled</Button>);
    const btn = screen.getByRole('button', { name: 'Styled' });
    expect(btn.className).toContain('custom-class');
  });
});

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

describe('Badge', () => {
  it('renders with default variant', () => {
    render(<Badge>Default</Badge>);
    const badge = screen.getByText('Default');
    expect(badge.className).toContain('bg-primary');
  });

  it('renders secondary variant', () => {
    render(<Badge variant="secondary">Secondary</Badge>);
    const badge = screen.getByText('Secondary');
    expect(badge.className).toContain('bg-secondary');
  });

  it('renders destructive variant', () => {
    render(<Badge variant="destructive">Error</Badge>);
    const badge = screen.getByText('Error');
    expect(badge.className).toContain('bg-destructive');
  });

  it('renders outline variant', () => {
    render(<Badge variant="outline">Outline</Badge>);
    const badge = screen.getByText('Outline');
    expect(badge.className).toContain('text-foreground');
  });

  it('merges custom className', () => {
    render(<Badge className="my-badge">Custom</Badge>);
    const badge = screen.getByText('Custom');
    expect(badge.className).toContain('my-badge');
  });
});

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

describe('Input', () => {
  it('renders a text input by default', () => {
    render(<Input placeholder="Name" />);
    const input = screen.getByPlaceholderText('Name') as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
  });

  it('renders with specified type', () => {
    render(<Input type="email" placeholder="Email" />);
    const input = screen.getByPlaceholderText('Email') as HTMLInputElement;
    expect(input.type).toBe('email');
  });

  it('forwards value and onChange', () => {
    const onInput = jest.fn();
    render(<Input value="hello" onInput={onInput} />);
    const input = screen.getByDisplayValue('hello') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'world' } });
    expect(onInput).toHaveBeenCalled();
  });

  it('applies disabled state', () => {
    render(<Input disabled placeholder="Disabled" />);
    const input = screen.getByPlaceholderText('Disabled') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it('merges custom className', () => {
    render(<Input className="wide-input" placeholder="Wide" />);
    const input = screen.getByPlaceholderText('Wide');
    expect(input.className).toContain('wide-input');
  });
});

// ---------------------------------------------------------------------------
// Textarea
// ---------------------------------------------------------------------------

describe('Textarea', () => {
  it('renders a textarea element', () => {
    render(<Textarea placeholder="Description" />);
    const textarea = screen.getByPlaceholderText('Description');
    expect(textarea.tagName).toBe('TEXTAREA');
  });

  it('applies disabled state', () => {
    render(<Textarea disabled placeholder="No edit" />);
    const textarea = screen.getByPlaceholderText('No edit') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
  });

  it('merges custom className', () => {
    render(<Textarea className="tall" placeholder="Tall" />);
    const textarea = screen.getByPlaceholderText('Tall');
    expect(textarea.className).toContain('tall');
  });
});

// ---------------------------------------------------------------------------
// Alert
// ---------------------------------------------------------------------------

describe('Alert', () => {
  it('renders with role="alert"', () => {
    render(<Alert>Something happened</Alert>);
    const alert = screen.getByRole('alert');
    expect(alert).toBeDefined();
  });

  it('renders default variant', () => {
    render(<Alert>Info</Alert>);
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('bg-background');
  });

  it('renders destructive variant', () => {
    render(<Alert variant="destructive">Error!</Alert>);
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('border-destructive');
  });

  it('renders title and description', () => {
    const el = (
      <Alert>
        <AlertTitle>Title</AlertTitle>
        <AlertDescription>Description text</AlertDescription>
      </Alert>
    );
    render(el as any);
    expect(screen.getByText('Title').tagName).toBe('H5');
    expect(screen.getByText('Description text')).toBeDefined();
  });

  it('merges custom className', () => {
    render(<Alert className="my-alert">Test</Alert>);
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('my-alert');
  });
});
