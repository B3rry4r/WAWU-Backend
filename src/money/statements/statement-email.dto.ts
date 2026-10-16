import { StatementQueryDto } from './statement-query.dto';

/**
 * POST /money/statements/email (task WALLET-35, W38): the same period and
 * format as `GET /money/statements`, in the body. There is no address: the
 * statement goes to the signed-in person's own confirmed email.
 */
export class StatementEmailDto extends StatementQueryDto {}
