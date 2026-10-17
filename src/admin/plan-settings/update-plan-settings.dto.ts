import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

/**
 * `PATCH /admin/plan-settings`: setting key to its new value. A null value
 * puts that setting back to its default. Each key's own check runs in the
 * service (src/plan-settings), which names the key and the reason.
 */
export class UpdatePlanSettingsDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Setting key to its new value; null puts the setting back to its default.',
    example: { 'plan.extra_products.price_kobo': 150000 },
  })
  @IsObject()
  settings!: Record<string, unknown>;
}
