type Argument = string | number | boolean;
type Localizer = (message: string, ...args: Argument[]) => string;

let localizer: Localizer | undefined;

/** Keep the CLI helpers usable in Node; VS Code supplies its localizer at activation. */
export function configureLocalization(value: Localizer | undefined): void { localizer = value; }

export function t(message: string, ...args: unknown[]): string {
    const values = args.map((value): Argument => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : String(value));
    if (localizer) { return localizer(message, ...values); }
    return message.replace(/\{(\d+)\}/g, (token, index: string) => Number(index) < values.length ? String(values[Number(index)]) : token);
}
