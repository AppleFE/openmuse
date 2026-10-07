import { z } from "zod";

export const hasControlCharacters = (value: string) =>
  Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

export const threadNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !hasControlCharacters(value), "대화 이름에는 제어 문자를 사용할 수 없습니다.")
  .transform((value) => value.normalize("NFKC").replace(/\s+/g, " "))
  .pipe(z.string().min(1).max(200));
export const threadNameKey = (name: string) =>
  name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
