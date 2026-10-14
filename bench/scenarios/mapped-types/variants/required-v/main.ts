interface Settings {
    alpha?: string;
    beta: number;
    gamma?: boolean[];
}

type Strict<T> = { [K in keyof T]-?: T[K] };

export type StrictSettings = Strict<Settings>;

export type RoundTrip = Required<Partial<Settings>>;
