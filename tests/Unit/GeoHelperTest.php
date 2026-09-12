<?php

namespace Tests\Unit;

use App\Helpers\GeoHelper;
use PHPUnit\Framework\TestCase;

class GeoHelperTest extends TestCase
{
    public function test_point_to_polyline_distance_uses_route_segments(): void
    {
        $geometry = [[14.90, 120.70], [14.90, 120.80]];

        $nearDistance = GeoHelper::distanceToPolylineMeters(14.904, 120.75, $geometry);
        $farDistance = GeoHelper::distanceToPolylineMeters(14.93, 120.75, $geometry);

        $this->assertLessThan(500, $nearDistance);
        $this->assertGreaterThan(3000, $farDistance);
    }
}
