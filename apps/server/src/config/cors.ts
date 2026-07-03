export type ServerCorsOptions = {
  origin: string[];
  methods: string[];
  allowedHeaders: string[];
};

export function buildCorsOptions(origins: string[]): ServerCorsOptions {
  return {
    origin: origins,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  };
}
