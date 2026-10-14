type Small = 1 | 2;
type Prefix = "x" | "y";
type Suffix = "a";

function getSmall(): Small {
    return Math.random() > 0.5 ? 1 : 2;
}

function getPrefix(): Prefix {
    return Math.random() > 0.5 ? "x" : "y";
}

function getSuffix(): Suffix {
    return "a";
}

function getFlag(): boolean {
    return Math.random() > 0.5;
}

const a: Small = getSmall();
const b: Small = getSmall();
const prefix: Prefix = getPrefix();
const suffix: Suffix = getSuffix();
const flag: boolean = getFlag();

const computed = {
    area: a * b,
    joined: prefix + suffix,
    total: 3 * 7 + 1,
    label: a + "px",
    enabled: flag && true,
} as const;

export type ComputedShape = typeof computed;
