const publicServiceSource = /^(?:packages\/core|packages\/runtime)\/src\/.*\.ts$/u;
const classStyleService = /\bextends\s+Context\.Service\s*</u;
const exportedService =
  /\bexport\s+const\s+\w+\s*(?::\s*Context\.Service\s*<[^;=]+>)?\s*=\s*Context\.Service\s*</gu;
const explicitServiceContract = /\bexport\s+const\s+\w+\s*:\s*Context\.Service\s*</u;

export const contextServiceDeclarationFailures = (sourceByFile) =>
  [...sourceByFile.entries()]
    .flatMap(([file, source]) => {
      if (!publicServiceSource.test(file)) return [];
      const failures = [];
      if (classStyleService.test(source)) {
        failures.push(
          `${file}: public Context services must use function-style Context.Service so canonical TypeScript 7 declarations preserve the service contract`,
        );
      }
      for (const match of source.matchAll(exportedService)) {
        if (!explicitServiceContract.test(match[0])) {
          failures.push(
            `${file}: exported Context.Service values require an explicit Context.Service annotation so canonical TypeScript 7 declarations cannot widen to any`,
          );
        }
      }
      return failures;
    })
    .sort();
