/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

import { newPolygon } from '../geo/polygon.js';
import { newPoint } from '../geo/point.js';
import { polygons } from '../geo/polygons.js';

export function parseAsync(text, opt) {
    return new Promise((resolve, reject) => {
        try {
            resolve(parse(text, opt));
        } catch (e) {
            reject(e);
        }
    });
}

export function parse(text, opt = { }) {
    const justPoly = opt.flat || false;
    const fromSoup = opt.soup !== false || justPoly;
    const depth = parseFloat(opt.depth || 5);
    const segmentSize = parseFloat(opt.segmentSize || 1); // default 1mm segments
    const minSegments = parseInt(opt.minSegments || 4); // minimum segments for very small arcs
    const objs = [];
    const polys = [];

    // Parse DXF file - normalize line endings and split
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').map(l => l.trim());
    const entities = extractEntities(lines);

    // Convert entities to polygons
    for (let entity of entities) {
        if (entity.type === 'POLYLINE' || entity.type === 'LWPOLYLINE') {
            if (entity.points.length < 2) {
                continue;
            }

            let poly = newPolygon().addPoints(
                entity.points.map(p => newPoint(p.x, p.y, p.z || 0))
            ).clean();

            // Check if closed
            if (entity.closed && poly.appearsClosed()) {
                poly.points.pop();
            } else if (!entity.closed) {
                poly.setOpen(true);
            }

            polys.push(poly);
        } else if (entity.type === 'LINE') {
            // Convert line to polyline
            let poly = newPolygon().addPoints([
                newPoint(entity.start.x, entity.start.y, entity.start.z || 0),
                newPoint(entity.end.x, entity.end.y, entity.end.z || 0)
            ]);
            poly.setOpen(true);
            polys.push(poly);
        } else if (entity.type === 'CIRCLE') {
            // Convert circle to polygon with points
            // Calculate segments based on circumference and desired segment size
            const circumference = 2 * Math.PI * entity.radius;
            const segments = Math.max(minSegments, Math.ceil(circumference / segmentSize));
            let points = [];
            for (let i = 0; i < segments; i++) {
                const angle = (i / segments) * Math.PI * 2;
                points.push(newPoint(
                    entity.center.x + Math.cos(angle) * entity.radius,
                    entity.center.y + Math.sin(angle) * entity.radius,
                    entity.center.z || 0
                ));
            }
            let poly = newPolygon().addPoints(points).clean();
            polys.push(poly);
        } else if (entity.type === 'ARC') {
            // Convert arc to polyline
            // Calculate segments based on arc length and desired segment size
            const arcLength = Math.abs(entity.endAngle - entity.startAngle) * entity.radius;
            const segments = Math.max(minSegments, Math.ceil(arcLength / segmentSize));
            let points = [];
            for (let i = 0; i <= segments; i++) {
                const angle = entity.startAngle + (i / segments) * (entity.endAngle - entity.startAngle);
                points.push(newPoint(
                    entity.center.x + Math.cos(angle) * entity.radius,
                    entity.center.y + Math.sin(angle) * entity.radius,
                    entity.center.z || 0
                ));
            }
            let poly = newPolygon().addPoints(points);
            poly.setOpen(true);
            polys.push(poly);
        }
    }

    // Nest polygons to identify holes vs outlines
    const sub = fromSoup ? polygons.nest(polys) : polys;
    const nest = sub.filter(p => {
        for (let pc of polys) {
            if (pc === p) {
                return true;
            } else {
                return !pc.isEquivalent(p);
            }
        }
    });

    if (justPoly) {
        return nest;
    }

    // Extrude polygons to 3D
    for (let poly of nest) {
        let obj = poly.extrude(depth);
        objs.push(obj);
    }

    return objs;
}

function extractEntities(lines) {
    const entities = [];
    let inEntities = false;
    let i = 0;

    while (i < lines.length - 1) {
        const code = lines[i];
        const value = lines[i + 1];

        // Check if we're in the ENTITIES section
        if (code === '0' && value === 'SECTION') {
            if (i + 3 < lines.length && lines[i + 2] === '2' && lines[i + 3] === 'ENTITIES') {
                inEntities = true;
                i += 4;
                continue;
            }
        }

        if (code === '0' && value === 'ENDSEC' && inEntities) {
            break;
        }

        if (inEntities && code === '0') {
            if (value === 'POLYLINE') {
                const entity = parsePolyline(lines, i);
                if (entity) {
                    entities.push(entity);
                    i = entity.endIndex;
                    continue;
                }
            } else if (value === 'LWPOLYLINE') {
                const entity = parseLWPolyline(lines, i);
                if (entity) {
                    entities.push(entity);
                    i = entity.endIndex;
                    continue;
                }
            } else if (value === 'LINE') {
                const entity = parseLine(lines, i);
                if (entity) {
                    entities.push(entity);
                    i = entity.endIndex;
                    continue;
                }
            } else if (value === 'CIRCLE') {
                const entity = parseCircle(lines, i);
                if (entity) {
                    entities.push(entity);
                    i = entity.endIndex;
                    continue;
                }
            } else if (value === 'ARC') {
                const entity = parseArc(lines, i);
                if (entity) {
                    entities.push(entity);
                    i = entity.endIndex;
                    continue;
                }
            }
        }

        i += 2;
    }

    return entities;
}

function parsePolyline(lines, start) {
    let i = start + 2;
    let closed = false;
    const points = [];

    // Read polyline flags
    while (i < lines.length - 1) {
        const code = lines[i];
        const value = lines[i + 1];

        if (code === '70') {
            // Polyline flag: 1 = closed
            closed = (parseInt(value) & 1) === 1;
        }

        if (code === '0' && value === 'VERTEX') {
            const vertex = parseVertex(lines, i);
            if (vertex) {
                points.push(vertex.point);
                i = vertex.endIndex;
                continue;
            }
        }

        if (code === '0' && value === 'SEQEND') {
            return { type: 'POLYLINE', points, closed, endIndex: i + 2 };
        }

        i += 2;
    }

    return null;
}

function parseVertex(lines, start) {
    let i = start + 2;
    const point = { x: 0, y: 0, z: 0 };

    while (i < lines.length - 1) {
        const code = lines[i];
        const value = lines[i + 1];

        if (code === '10') point.x = parseFloat(value);
        if (code === '20') point.y = parseFloat(value);
        if (code === '30') point.z = parseFloat(value);

        if (code === '0') {
            return { point, endIndex: i };
        }

        i += 2;
    }

    return { point, endIndex: i };
}

function parseLWPolyline(lines, start) {
    let i = start + 2;
    let closed = false;
    const points = [];
    let currentPoint = null;

    while (i < lines.length - 1) {
        const code = lines[i];
        const value = lines[i + 1];

        if (code === '70') {
            closed = (parseInt(value) & 1) === 1;
        }

        if (code === '10') {
            if (currentPoint) {
                points.push(currentPoint);
            }
            currentPoint = { x: parseFloat(value), y: 0, z: 0 };
        }

        if (code === '20' && currentPoint) {
            currentPoint.y = parseFloat(value);
        }

        if (code === '0') {
            if (currentPoint) {
                points.push(currentPoint);
            }
            return { type: 'LWPOLYLINE', points, closed, endIndex: i };
        }

        i += 2;
    }

    if (currentPoint) {
        points.push(currentPoint);
    }

    return { type: 'LWPOLYLINE', points, closed, endIndex: i };
}

function parseLine(lines, start) {
    let i = start + 2;
    const start_point = { x: 0, y: 0, z: 0 };
    const end_point = { x: 0, y: 0, z: 0 };

    while (i < lines.length - 1) {
        const code = lines[i];
        const value = lines[i + 1];

        if (code === '10') start_point.x = parseFloat(value);
        if (code === '20') start_point.y = parseFloat(value);
        if (code === '30') start_point.z = parseFloat(value);
        if (code === '11') end_point.x = parseFloat(value);
        if (code === '21') end_point.y = parseFloat(value);
        if (code === '31') end_point.z = parseFloat(value);

        if (code === '0') {
            return { type: 'LINE', start: start_point, end: end_point, endIndex: i };
        }

        i += 2;
    }

    return { type: 'LINE', start: start_point, end: end_point, endIndex: i };
}

function parseCircle(lines, start) {
    let i = start + 2;
    const center = { x: 0, y: 0, z: 0 };
    let radius = 0;

    while (i < lines.length - 1) {
        const code = lines[i];
        const value = lines[i + 1];

        if (code === '10') center.x = parseFloat(value);
        if (code === '20') center.y = parseFloat(value);
        if (code === '30') center.z = parseFloat(value);
        if (code === '40') radius = parseFloat(value);

        if (code === '0') {
            return { type: 'CIRCLE', center, radius, endIndex: i };
        }

        i += 2;
    }

    return { type: 'CIRCLE', center, radius, endIndex: i };
}

function parseArc(lines, start) {
    let i = start + 2;
    const center = { x: 0, y: 0, z: 0 };
    let radius = 0;
    let startAngle = 0;
    let endAngle = 0;

    while (i < lines.length - 1) {
        const code = lines[i];
        const value = lines[i + 1];

        if (code === '10') center.x = parseFloat(value);
        if (code === '20') center.y = parseFloat(value);
        if (code === '30') center.z = parseFloat(value);
        if (code === '40') radius = parseFloat(value);
        if (code === '50') startAngle = parseFloat(value) * Math.PI / 180; // Convert to radians
        if (code === '51') endAngle = parseFloat(value) * Math.PI / 180; // Convert to radians

        if (code === '0') {
            return { type: 'ARC', center, radius, startAngle, endAngle, endIndex: i };
        }

        i += 2;
    }

    return { type: 'ARC', center, radius, startAngle, endAngle, endIndex: i };
}
