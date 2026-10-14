const buildPoint = (x: number, y: number): { x: number; y: number; label?: string } => ({ x, y });

function describeItem(id: string, count: number, verbose?: boolean): string {
    return id + ":" + count + ":" + verbose;
}

const isNumeric = (input: string | number): input is number => typeof input === "number";

export interface VariantShape {
    point: ReturnType<typeof buildPoint>;
    describeArgs: Parameters<typeof describeItem>;
    described: ReturnType<typeof describeItem>;
    guard: typeof isNumeric;
}
