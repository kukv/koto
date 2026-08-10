/**
 * english_name は title の英訳であり、概念の同一性キー(「同じ english_name = 同じ概念」)。
 * 実装識別子を入れると、実装が概念とずれた命名になったときにカバーできなくなる。
 *
 * 持つのは term / event だけ。rule 系の title は命題なので、英訳しても説明文になりキーとして
 * 機能しない。任意にすると実装名を入れる習慣が戻るため、任意ではなく拒否する。
 */
const REQUIRED_TYPES = new Set(["term", "event"]);
const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

/**
 * english_name の正規化: 前後の空白を落とし、空文字は「未指定」(undefined)にする。
 * 検証にも保存にも必ずこの結果を使うこと — 別々に trim すると、検証は通った値と DB に
 * 保存される値がずれる(空文字が NULL でなく '' として入る、末尾空白が残る等)。
 */
export function normalizeEnglishName(englishName: string | null | undefined): string | undefined {
  const value = (englishName ?? "").trim();
  return value === "" ? undefined : value;
}

/** 規約違反ならエラーメッセージを返す(問題なければ null) */
export function validateEnglishName(
  type: string,
  englishName: string | null | undefined,
): string | null {
  const value = (englishName ?? "").trim();
  if (!REQUIRED_TYPES.has(type)) {
    return value === ""
      ? null
      : `type=${type} に english_name は登録できません。同一性キーとして機能するのは term / event の 2 つだけです`;
  }
  if (value === "") {
    return `type=${type} には english_name が必要です。title の英訳を小文字 snake_case で書いてください(クラス名・テーブル名・メソッド名などの実装識別子は不可)`;
  }
  if (!SNAKE_CASE.test(value)) {
    return `english_name「${value}」は形式が不正です。小文字 snake_case(^[a-z][a-z0-9_]*$)で、title の英訳を書いてください。実装識別子を写さないこと`;
  }
  return null;
}
