import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { SchoolsPublicService } from './schools-public.service';
import { ListPublicSchoolsDto } from './schools.dto';

/**
 * Schools, public (SCHOOLS-04): browsing needs no account. The literal
 * `courses` segment is declared before `:id` so it is not read as an id.
 */
@Controller('schools')
export class SchoolsPublicController {
  constructor(private readonly service: SchoolsPublicService) {}

  @Get()
  list(@Query() query: ListPublicSchoolsDto) {
    return this.service.list(query);
  }

  @Get('courses/:id')
  course(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.course(id);
  }

  @Get(':id')
  school(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.school(id);
  }
}
