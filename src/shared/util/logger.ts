import chalk from 'chalk';

export function info(msg: string): void {
  console.log(chalk.blue('[INFO]'), msg);
}

export function success(msg: string): void {
  console.log(chalk.green('[OK]'), msg);
}

export function warn(msg: string): void {
  console.log(chalk.yellow('[WARN]'), msg);
}

export function error(msg: string): void {
  console.error(chalk.red('[ERR]'), msg);
}

export function dry(msg: string): void {
  console.log(chalk.gray('[DRY]'), msg);
}

export function live(msg: string): void {
  console.log(chalk.cyan('  ↳'), msg);
}

export function separator(): void {
  console.log(chalk.dim('─'.repeat(60)));
}
