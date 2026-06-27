import { z } from 'zod';
export declare const healthResponseSchema: z.ZodObject<{
    status: z.ZodLiteral<"ok">;
}, z.core.$strip>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
//# sourceMappingURL=index.d.ts.map