import { z } from "zod";

/**
 * Отличаем «переменная не задана» от «задана неправильно»: инженер, читающий
 * ошибку старта, должен видеть разницу между забытой строкой в окружении и
 * опечаткой в ней.
 */
function absentOrWrong(whenWrong: string) {
  return (issue: { input: unknown }): string =>
    issue.input === undefined ? "переменная не задана" : whenWrong;
}

function isPostgresUrl(value: string): boolean {
  if (!URL.canParse(value)) {
    return false;
  }
  const { protocol } = new URL(value);
  return protocol === "postgres:" || protocol === "postgresql:";
}

/**
 * Окружение — такая же внешняя граница, как чужой HTTP-запрос, поэтому оно
 * проходит через схему zod (ADR-0003, п. 5). Гейтвей, стартовавший с
 * полупустой конфигурацией, обнаружит это на первом же платеже, и обнаружит
 * не он, а покупатель.
 */
const environmentSchema = z.object({
  /** Один Postgres на всё: заказы, квитанции, очередь (ADR-0003, п. 6). */
  DATABASE_URL: z
    .string({ error: absentOrWrong("должна быть строкой") })
    .refine(isPostgresUrl, "должна быть адресом вида postgres://пользователь@хост:порт/база"),
  /** Порт резидентного процесса; снаружи его закрывает Caddy. */
  PORT: z
    .string({ error: absentOrWrong("должен быть строкой") })
    .regex(/^\d+$/, "должен быть целым числом")
    .transform(Number)
    .refine((port) => port >= 1 && port <= 65535, "должен быть в диапазоне 1..65535")
    .default(3000),
});

/** Конфигурация гейтвея — то, без чего процесс не имеет права стартовать. */
export interface GatewayConfig {
  readonly databaseUrl: string;
  readonly port: number;
}

/**
 * Читает конфигурацию из окружения и называет разом все проблемы, а не первую
 * попавшуюся: инженер, поднимающий гейтвей, узнаёт весь список за один заход,
 * а не по одной переменной за перезапуск.
 */
export function loadConfig(environment: Record<string, string | undefined>): GatewayConfig {
  const parsed = environmentSchema.safeParse(environment);

  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const variable = issue.path.join(".");
      return variable === "" ? issue.message : `${variable}: ${issue.message}`;
    });

    throw new Error(`Гейтвей не может стартовать, конфигурация неполна — ${problems.join("; ")}`);
  }

  return {
    databaseUrl: parsed.data.DATABASE_URL,
    port: parsed.data.PORT,
  };
}
