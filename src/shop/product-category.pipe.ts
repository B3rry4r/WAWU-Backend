import { BadRequestException, ParseEnumPipe } from '@nestjs/common';
import { ProductCategory } from '../../generated/prisma/enums';

/**
 * FIX-17. `GET /shop/categories/:category/subcategories` with a category
 * outside the enum answered 500 (Prisma refused the value inside the query).
 * Now a 400 naming the field, in the words `GET /shop/products?category=`
 * already answers (`@IsEnum` in `ListProductsDto`).
 *
 * The shop is being retired (OPS-08), which answers 410 on this route and
 * drops its `category` argument; merged with it, this pipe goes too.
 */
export const PRODUCT_CATEGORY_PIPE = new ParseEnumPipe(ProductCategory, {
  exceptionFactory: () =>
    new BadRequestException(
      `category must be one of the following values: ${Object.values(ProductCategory).join(', ')}`,
    ),
});
