import asyncio
from database import engine, Alert
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

async def main():
    async with AsyncSession(engine) as session:
        # Count all alerts
        total = await session.scalar(select(func.count(Alert.id)))
        
        # Count alerts starting with 'http'
        http_count = await session.scalar(
            select(func.count(Alert.id)).where(Alert.snapshot_url.like('http%'))
        )
        
        print(f"Total alerts in PG: {total}")
        print(f"Alerts starting with http: {http_count}")
        print(f"Alerts NOT starting with http: {total - http_count}")
        
        # Print a few examples of alerts
        result = await session.execute(
            select(Alert.id, Alert.snapshot_url)
            .limit(5)
        )
        print("Examples of snapshot_urls:")
        for row in result.all():
            print(row)

if __name__ == "__main__":
    asyncio.run(main())
