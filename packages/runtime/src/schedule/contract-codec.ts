export const failScheduleContract = (message: string): never => {
  throw new TypeError(message);
};
